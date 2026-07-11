import {GatewayIntentsString} from "discord.js";
import {Server, ServerOptions} from "net-ipc";
import {BridgeInstance} from "./BridgeInstance";
import {BridgeCluster, BridgeClusterStatus} from "./BridgeCluster";
import {ClusterUtil} from "../utils/ClusterUtil";
import {z} from "zod";
import {SpawnClusterEvent} from "../events/SpawnClusterEvent";

export class Bridge {
    public readonly server: Server;
    public readonly clientOptions: BridgeClusterClientOptions;

    private readonly _instances: BridgeInstance[];
    private readonly _clusters: BridgeCluster[];

    private readonly totalShards: number;

    private readonly eventMap: BridgeEventListeners = {
        CLUSTER_READY: undefined,
        CLUSTER_HEARTBEAT_FAILED: undefined,
        CLUSTER_STOPPED: undefined,
        CLUSTER_SPAWNED: undefined,
        CLUSTER_RECLUSTER: undefined,
        INSTANCE_CONNECTED: undefined,
        INSTANCE_DISCONNECTED: undefined,
        INSTANCE_STOP_ACK: undefined,
        INSTANCE_STOP: undefined,
        ERROR: undefined
    }

    constructor(serverOptions: ServerOptions, clientOptions: BridgeClusterClientOptions, shardsPerCluster: number, clusterToStart: number, reclusteringTimeoutInMs: number) {
        this.server = new Server(serverOptions);
        this.clientOptions = clientOptions
        this.totalShards = shardsPerCluster

        this._instances = []
        this._clusters = ClusterUtil.calculateClusters(clusterToStart, shardsPerCluster);

        this.server.start().then(() => {
            this.startListening();
        })

        this.interval();
    }

    getUnconnectedCluster() {
        return this.clusters.filter(c => !c.instance)
    }

    private interval(): void {
        setInterval(() => {
            const unconnected = this.getUnconnectedCluster()
            if (unconnected.length > 0) {
                const instance = ClusterUtil.getInstanceWithLowestLoad(this.instances, this.clusters)
                if(instance) {
                    console.log("start", instance.id, unconnected[0].id)
                    this.start(instance, unconnected[0])
                }
            }
        }, 1000 * 5)
    }

    private startListening() {
        this.server.on('connect', (connection, data) => {
            const payload = BridgeConnectionPayload.safeParse(data);
            if(payload.success) {
                if(this.instances.find(i => i.id === payload.data.id)) {
                    connection.close("Already connected", false)
                    return
                }
                const instance = new BridgeInstance(payload.data.id, connection, payload.data.dev, payload.data.data);
                this._instances.push(instance);
                if (this.eventMap.INSTANCE_CONNECTED) this.eventMap.INSTANCE_CONNECTED(instance);
            } else {
                connection.close("Invalid payload", false)
            }
        })

        this.server.on('disconnect', (connection, reason) => {
            const instance = this._instances.find(i => i.connection === connection);
            if(!instance) {
                return
            }
            this.stopInstance(instance, reason)
        })
    }

    getClusterForInstance(instance: BridgeInstance) {
        return this._clusters.filter(c => c.instance === instance)
    }

    stopInstance(instance: BridgeInstance, reason: string) {
        this.getClusterForInstance(instance).forEach(cluster => {
            cluster.forceStop()
        })

        const index = this._instances.indexOf(instance);
        if (index !== -1) {
            this._instances.splice(index, 1);
        }
        if (this.eventMap.INSTANCE_DISCONNECTED) this.eventMap.INSTANCE_DISCONNECTED(instance, reason);
    }

    get clusters() {
        return this._clusters;
    }

    get instances() {
        return this._instances;
    }

    start(instance: BridgeInstance, cluster: BridgeCluster) {
        cluster.instance = instance;
        cluster.status = BridgeClusterStatus.STARTING
        instance.eventManager.send<SpawnClusterEvent>({
            type: 'SPAWN_CLUSTER',
            data: {
                clusterID: cluster.id,
                instanceID: instance.id,
                shardList: cluster.shards.map(s => s.id),
                token: this.clientOptions.token,
                intents: this.clientOptions.intents,
                url: this.clientOptions.url,
                totalShards: this.totalShards,
            }
        });
        if (this.eventMap.CLUSTER_SPAWNED) this.eventMap.CLUSTER_SPAWNED(cluster, instance);
    }

    public on<K extends keyof BridgeEventListeners>(event: K, listener: BridgeEventListeners[K]): void {
        this.eventMap[event] = listener;
    }
}

export type BridgeClusterClientOptions = {
    intents: GatewayIntentsString[];
    token: string;
    url?: string
}

export const BridgeConnectionPayload = z.object({
    id: z.number(),
    dev: z.boolean(),
    data: z.unknown()
})

export const BridgeClusterEventCreateCluster = z.object({
    type: 'CLUSTER_CREATE',
    data: z.object({
        clusterID: z.number(),
        instanceID: z.number(),
        shardList: z.array(z.number()),
        token: z.string(),
        intents: z.array(z.string()),
        url: z.string().optional(),
        totalShards: z.number(),
    })
})

export type BridgeClusterEventCreateCluster = z.infer<typeof BridgeClusterEventCreateCluster>

export type BridgeEventListeners = {
    'CLUSTER_READY': ((cluster: BridgeCluster, guilds: number, members: number, readyDuration: number) => void) | undefined,
    'CLUSTER_STOPPED': ((cluster: BridgeCluster) => void) | undefined,
    'CLUSTER_SPAWNED': ((cluster: BridgeCluster, connection: BridgeInstance) => void) | undefined,
    'CLUSTER_RECLUSTER': ((cluster: BridgeCluster, newConnection: BridgeInstance, oldConnection: BridgeInstance) => void) | undefined,
    'CLUSTER_HEARTBEAT_FAILED': ((cluster: BridgeCluster, error: unknown) => void) | undefined,
    'INSTANCE_CONNECTED': ((client: BridgeInstance) => void) | undefined,
    'INSTANCE_DISCONNECTED': ((client: BridgeInstance, reason: string) => void) | undefined,
    'INSTANCE_STOP_ACK': ((cluster: BridgeInstance) => void) | undefined,
    'INSTANCE_STOP': ((cluster: BridgeInstance) => void) | undefined,
    'ERROR': ((error: string) => void) | undefined,
};