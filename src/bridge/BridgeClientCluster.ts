import {BridgeClientConnection} from "./BridgeClientConnection";

export enum BridgeClientClusterConnectionStatus {
    REQUESTING = 'requesting',
    STARTING = 'starting',
    CONNECTED = 'connected',
    RECLUSTERING = 'reclustering',
    DISCONNECTED = 'disconnected',
}

export class BridgeClientCluster {
    public readonly clusterID: number;
    public readonly shardList: number[];
    public connectionStatus: BridgeClientClusterConnectionStatus = BridgeClientClusterConnectionStatus.DISCONNECTED;

    public connection?: BridgeClientConnection;

    public oldConnection?: BridgeClientConnection;

    public missedHeartbeats: number = 0;

    public heartbeatResponse?: HeartbeatResponse;

    public heartbeatPending = false;

    public startedAt?: number;

    constructor(clusterID: number, shardList: number[]) {
        this.clusterID = clusterID;
        this.shardList = shardList;
    }

    setConnection(connection?: BridgeClientConnection): void {
        if(connection == undefined){
            this.connectionStatus = BridgeClientClusterConnectionStatus.DISCONNECTED;
            this.connection = undefined;
            return;
        }

        if (this.connection) {
            throw new Error(`Connection already set for cluster ${this.clusterID}`);
        }

        this.connectionStatus = BridgeClientClusterConnectionStatus.REQUESTING;
        this.connection = connection;
    }

    setOldConnection(connection?: BridgeClientConnection): void {
        this.oldConnection = connection;
    }

    isUsed(): boolean {
        return this.connection != undefined && this.connectionStatus !== BridgeClientClusterConnectionStatus.DISCONNECTED;
    }

    reclustering(connection: BridgeClientConnection): void {
        this.connectionStatus = BridgeClientClusterConnectionStatus.RECLUSTERING;
        this.oldConnection = this.connection;
        this.connection = connection;
    }

    addMissedHeartbeat(): void {
        this.missedHeartbeats++;
    }

    removeMissedHeartbeat(): void {
        if (this.missedHeartbeats > 0) {
            this.missedHeartbeats--;
        }
    }

    resetMissedHeartbeats(): void {
        this.missedHeartbeats = 0;
    }
}

export type HeartbeatResponse = {
    cpu: {
        raw: {
            user: number,
            system: number,
        }
        cpuPercent: string
    },
    memory: {
        raw: {
            rss: number,
            heapTotal: number,
            heapUsed: number,
            external: number,
            arrayBuffers: number,
        },
        memoryPercent: string
        usage: number
    },
    ping: number,
    shardPings: {
        id: number,
        ping: number,
        status: number,
        guilds: number,
        members: number
    }[]
}