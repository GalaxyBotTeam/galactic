import {ChildProcess} from "child_process";
import {EventManager} from "../general/EventManager";

export type ClusterProcessState = 'starting' | 'running' | 'stopped';

export class ClusterProcess {
    public readonly child: ChildProcess;
    public readonly eventManager: EventManager;
    public readonly id: number;
    public readonly shardList: number[];
    public readonly totalShards: number;
    public status: ClusterProcessState;
    public readonly createdAt: number = Date.now();

    private _onMessage?: (message: unknown) => void;
    private _onRequest?: (message: unknown) => unknown;

    constructor(id: number, child: ChildProcess, shardList: number[], totalShards: number) {
        this.id = id;
        this.child = child;
        this.shardList = shardList;
        this.totalShards = totalShards;
        this.status = 'starting';
        this.eventManager = new EventManager((message) => {
            return new Promise<void>((resolve, reject) => {
                this.child.send(message, (error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            })
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

        this.child.on('message', (message) => {
            this.eventManager.receive(message);
        });

        // Ensure we do not retain pending requests if the child dies or errors
        this.child.on('exit', () => {
            this.eventManager.close('child process exited');
        });
        this.child.on('error', () => {
            this.eventManager.close('child process error');
        });
    }

    onMessage(callback: (message: unknown) => void) {
        this._onMessage = callback;
    }

    onRequest(callback: (message: unknown) => unknown) {
        this._onRequest = callback;
    }

    public sendMessage(data: unknown) {
        this.eventManager.send({
            type: 'CUSTOM',
            data: data,
        });
    }

    public sendRequest(data: unknown, timeout = 5000): Promise<unknown> {
        return this.eventManager.request({
            type: 'CUSTOM',
            data: data,
        }, timeout);
    }
}