import {EventManager} from "../general/EventManager";
import {Connection} from "net-ipc";

export enum BridgeClientConnectionStatus {
    READY = 'ready',
    PENDING_STOP = 'pending_stop',
}
export class BridgeClientConnection {
    public readonly instanceID: number;
    public readonly eventManager: EventManager;
    public readonly connection: Connection;
    public readonly data: unknown;
    public connectionStatus: BridgeClientConnectionStatus = BridgeClientConnectionStatus.READY;
    public readonly dev: boolean = false;

    private _onMessage?: (message: unknown) => void;
    private _onRequest?: (message: unknown) => unknown;

    constructor(instanceID: number, connection: Connection, data: unknown, dev: boolean) {
        this.instanceID = instanceID;
        this.connection = connection;
        this.data = data;
        this.dev = dev || false;
        this.eventManager = new EventManager((message) => {
            if(!this.connection?.connection?.closed){
                return this.connection.send(message);
            }
            return Promise.reject(new Error('Connection is closed, cannot send message'));
        }, (message) => {
            if (this._onMessage) {
                this._onMessage(message);
            }
        }, (message) => {
            if (this._onRequest) {
                return this._onRequest(message);
            }
            return undefined;
        })
    }

    messageReceive(message: any) {
        this.eventManager.receive(message);
    }

    onRequest(callback: (message: unknown) => unknown) {
        this._onRequest = callback;
    }

    onMessage(callback: (message: unknown) => void) {
        this._onMessage = callback;
    }
}