import { Room, RoomBase } from "./room";
import { HostedRoom } from "./hostedRoom";
import { RedisClient } from "redis";
import { Events } from "../../../shared/events";
import { isDate } from "util";
import { redisClient } from "../lib/redis";

export class Player {
    isHost: boolean = false
    socket: SocketIO.Socket

    hostedRoom?: Room
    joinedRoom?: Room

    constructor(socket: SocketIO.Socket) {
        this.socket = socket
    }

    host(password: string) {

        if (this.isHost) {
            this.socket.emit(Events.alreadyHosting)
            return
        }

        this.isHost = true

        let room = new HostedRoom(password, (success, code) => {
            if (!success) {
                this.socket.emit(Events.roomCreationFailed)
                this.isHost = false
                return
            }
            this.socket.emit(Events.roomCreated, code)

            this.hostedRoom = room

        })

    }

    attemptJoining(roomName: string) {
        if (this.isHost) {
            this.sendEvent(Events.alreadyHosting)
            return
        }

        let code = roomName.toUpperCase()

        if (code.length != 4 || !/[^A-Z]/.test(code)) {
            this.sendEvent(Events.invalidRoomCode)
            return
        }

        redisClient.sismember("rooms", code, (err, number) => {
            if (number != 1) {
                this.sendEvent(Events.invalidRoomCode)
                return
            }

            this.joinRoom(code)
        })

    }

    private joinRoom(roomCode: string) {
        this.leaveRoom()

        RoomBase.getRoom(roomCode)
            .then((room) => {
                return room.playerJoined(this)

            }).then((room) => {
                this.joinedRoom = room
            })
            .catch((error) => {
                console.error(error)
            })
    }

    private leaveRoom() {
        if (this.joinedRoom == null) {
            return
        }
        this.joinedRoom.playerLeft(this)
    }

    sendEvent(event: string) {
        this.socket.emit(event)
    }
}