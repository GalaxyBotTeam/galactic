import {BotInstance} from "./BotInstance";
import {ClusterProcess} from "../cluster/ClusterProcess";
import {GatewayIntentsString} from "discord.js";
import {ShardingUtil} from "../general/ShardingUtil";

export class StandaloneInstance extends BotInstance {
    private readonly totalClusters: number;
    private readonly shardsPerCluster: number;

    public readonly token: string;
    public readonly intents: GatewayIntentsString[];

    constructor(entryPoint: string, shardsPerCluster: number, totalClusters: number, token: string, intents: GatewayIntentsString[], execArgv?: string[]) {
        super(entryPoint, execArgv);
        this.shardsPerCluster = shardsPerCluster;
        this.totalClusters = totalClusters;
        this.token = token;
        this.intents = intents;
    }

    get totalShards(): number {
        return this.shardsPerCluster * this.totalClusters;
    }

    private calculateClusters(): Record<number, number[]> {
        const clusters: Record<number, number[]> = {};
        for (let i = 0; i < this.totalClusters; i++) {
            clusters[i] = [];
            for (let j = 0; j < this.shardsPerCluster; j++) {
                clusters[i].push(i * this.shardsPerCluster + j);
            }
        }
        return clusters;
    }

    public start(): void {
        const clusters = this.calculateClusters();
        for (const [id, shardList] of Object.entries(clusters)) {
            this.startProcess(1, Number(id), shardList, this.totalShards, this.token, this.intents);
        }
    }

    protected setClusterStopped(client: ClusterProcess, reason: string): void {
        this.clients.delete(client.id);
        this.restartProcess(client);
    }

    protected setClusterReady(client: ClusterProcess): void {
        
    }

    protected setClusterSpawned(client: ClusterProcess): void {

    }

    private restartProcess(client: ClusterProcess): void {
        this.startProcess(1, client.id, client.shardList, this.totalShards, this.token, this.intents);
    }

    protected onRequest(client: ClusterProcess, message: any): Promise<unknown> {
        if(message.type === 'REDIRECT_REQUEST_TO_GUILD'){
            const guildID = message.guildID;
            const data = message.data;

            const shardID = ShardingUtil.getShardIDForGuild(guildID, client.totalShards);
            if(client.shardList.includes(shardID)) {
                return client.eventManager.request({
                    type: 'CUSTOM',
                    data: data
                }, 5000)
            } else {
                return Promise.reject(new Error(`Shard ID ${shardID} not found in cluster ${client.id} for guild ${guildID}`));
            }
        }

        if(message.type == 'BROADCAST_EVAL') {
            return Promise.all(
                this.clients.values().map(c => {
                    return c.eventManager.request({
                        type: 'BROADCAST_EVAL',
                        data: message.data,
                    }, 5000);
                })
            );
        }

        if(message.type == 'CUSTOM' && this.eventMap.request) {
            return new Promise((resolve, reject) => {
                this.eventMap.request!(client, message.data, resolve, reject);
            });
        }

        return Promise.reject(new Error(`Unknown request type: ${message.type}`));
    }

}