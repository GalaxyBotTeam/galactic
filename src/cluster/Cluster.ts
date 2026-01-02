import {Client, GatewayIntentsString, Status} from "discord.js";
import {EventManager} from "../general/EventManager";
import os from "os";
export class Cluster<T extends Client> {

    public readonly instanceID: number;

    public readonly clusterID: number;

    public readonly shardList: number[] = [];

    public readonly totalShards: number;

    public readonly token: string;

    public readonly intents: GatewayIntentsString[];

    public eventManager: EventManager;

    public client!: T;

    private readonly eventMap: {
        'message': ((message: unknown) => void) | undefined,
        'request': ((message: unknown, resolve: (data: unknown) => void, reject: (error: any) => void) => void) | undefined,
        'CLUSTER_READY': (() => void) | undefined,
    } = {
        message: undefined, request: undefined, CLUSTER_READY: undefined,
    }

    constructor(instanceID: number, clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[]) {
        this.instanceID = instanceID;
        this.clusterID = clusterID;
        this.shardList = shardList;
        this.totalShards = totalShards;
        this.token = token;
        this.intents = intents;
        this.eventManager = new EventManager((message: unknown) => {
            return new Promise((resolve, reject) => {
                if (typeof process.send !== 'function') {
                    reject(new Error("Process does not support sending messages"));
                    return;
                }

                process.send?.(message, undefined, undefined, (error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        }, (message: unknown) => {
            this._onMessage(message);
        }, (message: unknown) => {
            return this._onRequest(message);
        });
        process.on("message", (message) => {
            this.eventManager.receive(message);
        })
    }

    static initial<T extends Client>(): Cluster<T> {
        const args = process.env;

        if (args.SHARD_LIST == undefined || args.INSTANCE_ID == undefined || args.TOTAL_SHARDS == undefined || args.TOKEN == undefined || args.INTENTS == undefined || args.CLUSTER_ID == undefined) {
            throw new Error("Missing required environment variables");
        }

        const shardList = args.SHARD_LIST.split(',').map(Number);

        const totalShards = Number(args.TOTAL_SHARDS);

        const instanceID = Number(args.INSTANCE_ID);
        const clusterID = Number(args.CLUSTER_ID);

        const token = args.TOKEN;

        const intents = args.INTENTS.split(',').map(i => i.trim()) as GatewayIntentsString[];

        return new Cluster<T>(instanceID, clusterID, shardList, totalShards, token, intents);
    }

    triggerReady(guilds: number, members: number) {
        this.eventManager.send({
            type: 'CLUSTER_READY',
            id: this.clusterID,
            guilds: guilds,
            members: members,
        });

        if(this.eventMap?.CLUSTER_READY) {
            this.eventMap?.CLUSTER_READY();
        }
    }

    triggerError(e: any) {
        this.eventManager.send({
            type: 'CLUSTER_ERROR',
            id: this.clusterID,
        });
    }

    private async wait(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private _onMessage(message: unknown): void {
        const m = message as { type: string, data: unknown };
        if(m.type == 'CUSTOM' && this.eventMap.message) {
            this.eventMap.message!(m.data);
        }
    }

    private _onRequest(message: unknown): unknown {
        const m = message as { type: string, data: unknown };
        if(m.type == 'CUSTOM' && this.eventMap.request) {
            return new Promise((resolve, reject) => {
                this.eventMap.request!(m.data, resolve, reject);
            });
        } else if(m.type == 'CLUSTER_HEARTBEAT'){
            const startTime = process.hrtime.bigint();
            const startUsage = process.cpuUsage();

            (async () => {
                await this.wait(500);
            })();

            const endTime = process.hrtime.bigint();
            const usageDiff = process.cpuUsage(startUsage);

            const elapsedTimeUs = Number((endTime - startTime) / 1000n);
            const totalCPUTime = usageDiff.user + usageDiff.system;

            const cpuCount = os.cpus().length;
            const cpuPercent = (totalCPUTime / (elapsedTimeUs * cpuCount)) * 100;

            // Collect per-shard ping information in addition to the overall ws ping
            let shardPings: { id: number, ping: number, status: Status, uptime?: unknown, guilds: number, members: number }[] = [];
            try {
                const shards = this.client.ws.shards;

                if(shards) {
                    shards.forEach((shard) => {
                        shardPings.push({ id: shard.id, ping: shard.ping, status: shard.status,
                            guilds: this.client.guilds.cache.filter(g => g.shardId === shard.id).size,
                            members: this.client.guilds.cache.filter(g => g.shardId === shard.id).reduce((acc, g) => acc + g.memberCount, 0)
                        });

                        this.client.shard?.fetchClientValues('uptime', shard.id).then(values => {
                            shardPings[shard.id]["uptime"] = values
                            console.log(values)
                        }).catch(e => {

                        })
                    })
                }
            } catch (_) {
                // ignore and keep empty shardPings on failure
            }

            return {
                cpu: { raw: process.cpuUsage(), cpuPercent: cpuPercent.toFixed(2) },
                memory: { raw: process.memoryUsage(),
                    memoryPercent: ((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100).toFixed(2) + '%',
                    usage: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + 'MB'
                },
                ping: this.client.ws.ping,
                shardPings: shardPings,
            }
        } else if(m.type == 'BROADCAST_EVAL'){
            const broadcast = message as { type: 'BROADCAST_EVAL', data: string }

            const fn = eval(`(${broadcast.data})`);

            const result = fn(this.client);
            if(result instanceof Promise){
                return new Promise((resolve, reject) => {
                    result.then(res => {
                        resolve(res);
                    }).catch(err => {
                        reject(err);
                    });
                });
            } else {
                return result;
            }
        } else if(m.type == 'SELF_DESTRUCT') {
            // TODO
        }
        return undefined;
    }

    public on<K extends keyof ClusterEventListeners>(event: K, listener: ClusterEventListeners[K]): void {
        this.eventMap[event] = listener;
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

    public broadcastEval<Result>(fn: (cluster: T) => Result, timeout = 20000): Promise<Result[]> {
        return this.eventManager.request({
            type: 'BROADCAST_EVAL',
            data: fn.toString(),
        }, timeout);
    }


    public sendMessageToClusterOfGuild(guildID: string, message: unknown): void {
        if (this.eventManager) {
            this.eventManager.send({
                type: 'REDIRECT_MESSAGE_TO_GUILD',
                guildID: guildID,
                data: message
            });
        }
    }

    public sendRequestToClusterOfGuild(guildID: string, message: unknown, timeout = 5000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (this.eventManager) {
                this.eventManager.request({
                    type: 'REDIRECT_REQUEST_TO_GUILD',
                    guildID: guildID,
                    data: message
                }, timeout).then((response) => {
                    resolve(response);
                }).catch((error) => {
                    reject(error);
                });
            } else {
                reject(new Error("Event manager is not initialized"));
            }
        });
    }
}

export type ClusterEventListeners = {
    message: (message: unknown) => void;
    request: (message: unknown, resolve: (data: unknown) => void, reject: (error: any) => void) => void;

    CLUSTER_READY: () => void;
};