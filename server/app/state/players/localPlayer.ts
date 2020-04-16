import { Room, RoomBase, RoomKeys } from "../room";
import { HostedRoom } from "../hostedRoom";
import { RedisClient } from "redis";
import { Events } from "../../../../client/shared/events";
import { isDate } from "util";
import { redisClient, redisSubscriber } from "../../lib/redis";
import { randomCode } from "../../lib/generator";
import { state } from "../state";
import { Socket } from "socket.io";
import { Session } from "../session";
import { Player, PlayerMessage } from "./player";
import { eventEmitter } from "../../lib/event";
import { PlayerCommands } from "./proxyPlayer";

enum PlayerKeys {
    name = "name",
    id = "id",
    lastSeen = "lastSeen"
}

export class LocalPlayer implements Player {

    id: string
    name: string

    isHost: boolean = false
    session?: Session
    lastSeen = new Date().getTime()
    active = true

    hostedRoom?: Room
    joinedRoom?: Room

    constructor(id: string, name: string) {
        this.id = id
        this.name = name

        let key = `user:${id}`

        redisClient.multi()
            // Create the player, expire it in ten minutes
            .hmset(key,
                PlayerKeys.id, id,
                PlayerKeys.name, name,
                PlayerKeys.lastSeen, new Date().getTime())
            .expire(key, 60 * 10)
            .exec()

        // Set listeners

        let channelName = `events:to:${key}`

        eventEmitter.on(channelName, this.onMessage)
        redisSubscriber.subscribe(channelName)

    }

    onMessage(message: PlayerMessage) {
        switch(message.type) {
            case PlayerCommands.sendEvent:
                this.sendEvent(message.payload.event, message.payload.payload)
                break
            case PlayerCommands.successfullyJoined:
                RoomBase.getRoom(message.payload).then((room) => {
                    this.successfullyJoinedRoom(room)
                }).catch((err) => {
                    console.error("Error finding room in remote join: ", err)
                })
        }
    }

    host(password?: string) {

        if (this.isHost) {
            this.session?.emit(Events.alreadyHosting)
            return
        }

        this.isHost = true

        let room = new HostedRoom(this, password, (success, code) => {
            if (!success) {
                this.session?.emit(Events.roomCreationFailed)
                this.isHost = false
                return
            }
            this.session?.emit(Events.roomCreated, code)

            this.hostedRoom = room

        })

    }

    attemptJoining(payload: Record<string, string>) {

        let code = payload.gameId.toUpperCase()

        if (code.length != 4 || /[^A-Z]/.test(code)) {
            console.debug("Invalid room code " + code)
            this.sendEvent(Events.invalidRoomCode)
            return
        }

        redisClient.hgetall(`room:${code}`, (err, value) => {
            if (err != null || value == null) {
                this.sendEvent(Events.invalidRoomCode)
                return
            }

            if (value[RoomKeys.passwordProtected] == String(false)) {
                this.joinRoom(code)
                return
            }

            // Password protected!
            if (payload.password == null) {
                this.sendEvent(Events.passwordNeeded)

            } else if (value[RoomKeys.password] !== payload.password) {
                // Bad way to prevent bruteforce
                setTimeout(() => {
                    this.sendEvent(Events.invalidPassword)
                }, 1500)

            } else {
                // Good to go
                this.joinRoom(code, payload.password)
            }


        })

    }

    private joinRoom(roomCode: string, password?: string) {
        this.leaveRoom()
        this.isHost = false

        

        RoomBase.getRoom(roomCode)
            .then((room) => {

                console.log("joining")

                room.tryJoining(this)

            })
            .catch((error) => {
                this.sendEvent(Events.cannotJoin)
            })
    }

    successfullyJoinedRoom(room: Room) {
        this.joinedRoom = room
        this.session?.joinedRoom(room)
        this.sendEvent(Events.joinedGame, room.roomCode)
    }

    private leaveRoom() {
        this.joinedRoom?.playerLeft(this)
    }

    sendEvent(event: string, payload?: any) {
        this.session?.emit(event, payload)
    }

    connect(session: Session) {
        // To avoid multiple tabs logged in as the same user
        this.session?.forceEnd()
        this.active = true
        this.session = session
    }

    disconnect(session: Session) {
        if (session == this.session) {
            this.active = false
            this.lastSeen = new Date().getTime()
            console.log("disconnect")
        }
    }

    renew() {
        let now = new Date().getTime()
        // Reset the expiry timer
        if (this.lastSeen < now - 300000) {
            let key = `users:${this.id}`
            redisClient.multi()
                .expire(`users:${this.id}`, 60 * 10)
                .hset(key, PlayerKeys.lastSeen, String(now))
            this.lastSeen = now
        }
    }

    clean() {
        redisClient.del(`users:${this.id}`)
    }
}