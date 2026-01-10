// src/bridge/BridgeClientCluster.ts
var BridgeClientClusterConnectionStatus = /* @__PURE__ */ ((BridgeClientClusterConnectionStatus2) => {
  BridgeClientClusterConnectionStatus2["REQUESTING"] = "requesting";
  BridgeClientClusterConnectionStatus2["STARTING"] = "starting";
  BridgeClientClusterConnectionStatus2["CONNECTED"] = "connected";
  BridgeClientClusterConnectionStatus2["RECLUSTERING"] = "reclustering";
  BridgeClientClusterConnectionStatus2["DISCONNECTED"] = "disconnected";
  return BridgeClientClusterConnectionStatus2;
})(BridgeClientClusterConnectionStatus || {});
var BridgeClientCluster = class {
  clusterID;
  shardList;
  connectionStatus = "disconnected" /* DISCONNECTED */;
  connection;
  oldConnection;
  missedHeartbeats = 0;
  heartbeatResponse;
  heartbeatPending = false;
  startedAt;
  constructor(clusterID, shardList) {
    this.clusterID = clusterID;
    this.shardList = shardList;
  }
  setConnection(connection) {
    if (connection == void 0) {
      this.connectionStatus = "disconnected" /* DISCONNECTED */;
      this.connection = void 0;
      return;
    }
    if (this.connection) {
      throw new Error(`Connection already set for cluster ${this.clusterID}`);
    }
    this.connectionStatus = "requesting" /* REQUESTING */;
    this.connection = connection;
  }
  setOldConnection(connection) {
    this.oldConnection = connection;
  }
  isUsed() {
    return this.connection != void 0 && this.connectionStatus !== "disconnected" /* DISCONNECTED */;
  }
  reclustering(connection) {
    this.connectionStatus = "reclustering" /* RECLUSTERING */;
    this.oldConnection = this.connection;
    this.connection = connection;
  }
  addMissedHeartbeat() {
    this.missedHeartbeats++;
  }
  removeMissedHeartbeat() {
    if (this.missedHeartbeats > 0) {
      this.missedHeartbeats--;
    }
  }
  resetMissedHeartbeats() {
    this.missedHeartbeats = 0;
  }
};

// src/general/EventManager.ts
var EventManager = class {
  pendingPayloads = /* @__PURE__ */ new Map();
  // Track per-request timeout handles so we can clear them on resolve/reject
  pendingTimeouts = /* @__PURE__ */ new Map();
  _send;
  _on;
  _request;
  constructor(send, on, request) {
    this._send = send;
    this._on = on;
    this._request = request;
  }
  async send(data) {
    return this._send({
      id: crypto.randomUUID(),
      type: "message",
      data
    });
  }
  async request(payload, timeout) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this._send({
        id,
        type: "request",
        data: payload
      });
      this.pendingPayloads.set(id, {
        resolve,
        reject
      });
      const t = setTimeout(() => {
        if (this.pendingPayloads.has(id)) {
          this.pendingPayloads.delete(id);
          this.pendingTimeouts.delete(id);
          reject({
            error: `Request with id ${id} timed out`
          });
        }
      }, timeout);
      this.pendingTimeouts.set(id, t);
    });
  }
  receive(possiblePayload) {
    if (typeof possiblePayload !== "object" || possiblePayload === null) {
      return;
    }
    const payload = possiblePayload;
    if (!payload.id || !payload.type) {
      return;
    }
    if (payload.type === "message") {
      this._on(payload.data);
      return;
    }
    if (payload.type === "response") {
      const resolve = this.pendingPayloads.get(payload.id)?.resolve;
      if (resolve) {
        resolve(payload.data);
        this.pendingPayloads.delete(payload.id);
        const to = this.pendingTimeouts.get(payload.id);
        if (to) clearTimeout(to);
        this.pendingTimeouts.delete(payload.id);
      }
      return;
    }
    if (payload.type === "response_error") {
      const reject = this.pendingPayloads.get(payload.id)?.reject;
      if (reject) {
        reject(payload.data);
        this.pendingPayloads.delete(payload.id);
        const to = this.pendingTimeouts.get(payload.id);
        if (to) clearTimeout(to);
        this.pendingTimeouts.delete(payload.id);
      }
      return;
    }
    if (payload.type === "request") {
      const data = this._request(payload.data);
      if (data instanceof Promise) {
        data.then((result2) => {
          this._send({
            id: payload.id,
            type: "response",
            data: result2
          });
        }).catch((error) => {
          this._send({
            id: payload.id,
            type: "response_error",
            data: error
          });
        });
      } else {
        this._send({
          id: payload.id,
          type: "response",
          data
        });
      }
      return;
    }
  }
  // Reject and clear all pending requests to avoid memory leaks when a connection/process closes
  close(reason) {
    if (this.pendingPayloads.size === 0 && this.pendingTimeouts.size === 0) return;
    const err = { error: reason || "EventManager closed" };
    for (const [id, handlers] of this.pendingPayloads.entries()) {
      try {
        handlers.reject(err);
      } catch (_) {
      }
      this.pendingPayloads.delete(id);
      const to = this.pendingTimeouts.get(id);
      if (to) clearTimeout(to);
      this.pendingTimeouts.delete(id);
    }
    for (const to of this.pendingTimeouts.values()) {
      clearTimeout(to);
    }
    this.pendingTimeouts.clear();
  }
};

// src/bridge/BridgeClientConnection.ts
var BridgeClientConnectionStatus = /* @__PURE__ */ ((BridgeClientConnectionStatus2) => {
  BridgeClientConnectionStatus2["READY"] = "ready";
  BridgeClientConnectionStatus2["PENDING_STOP"] = "pending_stop";
  return BridgeClientConnectionStatus2;
})(BridgeClientConnectionStatus || {});
var BridgeClientConnection = class {
  instanceID;
  eventManager;
  connection;
  data;
  connectionStatus = "ready" /* READY */;
  dev = false;
  establishedAt = Date.now();
  _onMessage;
  _onRequest;
  constructor(instanceID, connection, data, dev) {
    this.instanceID = instanceID;
    this.connection = connection;
    this.data = data;
    this.dev = dev || false;
    this.eventManager = new EventManager((message2) => {
      if (!this.connection?.connection?.closed) {
        return this.connection.send(message2);
      }
      return Promise.reject(new Error("Connection is closed, cannot send message"));
    }, (message2) => {
      if (this._onMessage) {
        this._onMessage(message2);
      }
    }, (message2) => {
      if (this._onRequest) {
        return this._onRequest(message2);
      }
      return void 0;
    });
  }
  messageReceive(message2) {
    this.eventManager.receive(message2);
  }
  onRequest(callback) {
    this._onRequest = callback;
  }
  onMessage(callback) {
    this._onMessage = callback;
  }
};

// src/bridge/Bridge.ts
import { Server } from "net-ipc";

// src/bridge/ClusterCalculator.ts
var ClusterCalculator = class {
  /** The total number of clusters to initialize */
  clusterToStart;
  /** The number of shards that each cluster will manage */
  shardsPerCluster;
  /** List of all clusters managed by this calculator */
  clusterList = [];
  /**
   * Creates a new ClusterCalculator and initializes the clusters.
   * 
   * @param clusterToStart - The number of clusters to create
   * @param shardsPerCluster - The number of shards each cluster will manage
   */
  constructor(clusterToStart, shardsPerCluster) {
    this.shardsPerCluster = shardsPerCluster;
    this.clusterToStart = clusterToStart;
    this.calculateClusters();
  }
  /**
   * Calculates and initializes all clusters with their assigned shards.
   * Each cluster is assigned a sequential range of shard IDs based on its cluster index.
   */
  calculateClusters() {
    const clusters = /* @__PURE__ */ new Map();
    for (let i = 0; i < this.clusterToStart; i++) {
      clusters.set(i, []);
      for (let j = 0; j < this.shardsPerCluster; j++) {
        clusters.get(i)?.push(i * this.shardsPerCluster + j);
      }
    }
    for (let [clusterIndex, clusterShards] of clusters.entries()) {
      this.clusterList.push(new BridgeClientCluster(clusterIndex, clusterShards));
    }
  }
  /**
   * Retrieves the next available (unused) cluster and marks it as used.
   * 
   * @returns The next available cluster, or undefined if all clusters are in use
   */
  getNextCluster() {
    for (const cluster of this.clusterList) {
      if (!cluster.isUsed()) {
        return cluster;
      }
    }
    return void 0;
  }
  /**
   * Retrieves multiple available clusters up to the specified count.
   * Each returned cluster is marked as used.
   * 
   * @param count - The maximum number of clusters to retrieve
   * @returns An array of available clusters (may be fewer than requested if not enough are available)
   */
  getNextClusters(count) {
    const availableClusters = [];
    for (const cluster of this.clusterList) {
      if (!cluster.isUsed() && availableClusters.length < count) {
        availableClusters.push(cluster);
      }
    }
    return availableClusters;
  }
  /**
   * Sets the used status of a specific cluster by its ID.
   *
   * @param clusterID - The ID of the cluster to update
   * @param connection - The connection to associate with the cluster
   */
  clearClusterConnection(clusterID) {
    const cluster = this.clusterList.find((c) => c.clusterID === clusterID);
    if (cluster) {
      cluster.setConnection(void 0);
    }
  }
  getClusterForConnection(connection) {
    return this.clusterList.filter(
      (cluster) => cluster.connection?.instanceID === connection.instanceID
    );
  }
  getOldClusterForConnection(connection) {
    return this.clusterList.filter(
      (cluster) => cluster.oldConnection?.instanceID === connection.instanceID
    );
  }
  checkAllClustersConnected() {
    for (const cluster of this.clusterList) {
      if (cluster.connectionStatus != "connected" /* CONNECTED */) {
        return false;
      }
    }
    return true;
  }
  findMostAndLeastClustersForConnections(connectedClients) {
    const openClients = connectedClients.filter((x) => !x.dev);
    const devClients = connectedClients.filter((x) => x.dev);
    const summDevConnectedClusters = devClients.map((c) => this.getClusterForConnection(c).length).reduce((a, b) => a + b, 0);
    let most;
    let least;
    let remainder = (this.clusterToStart - summDevConnectedClusters) % openClients.length || 0;
    for (const client of openClients) {
      const clusters = this.getClusterForConnection(client);
      if (!most || clusters.length > this.getClusterForConnection(most).length) {
        most = client;
      }
      if (!least || clusters.length < this.getClusterForConnection(least).length) {
        least = client;
      }
    }
    if (most && least) {
      const mostCount = this.getClusterForConnection(most).length;
      const leastCount = this.getClusterForConnection(least).length;
      if (mostCount - leastCount <= remainder) {
        return { most: void 0, least: void 0 };
      }
    }
    return { most, least };
  }
  getClusterWithLowestLoad(connectedClients) {
    let lowestLoadClient;
    let lowestLoad = Infinity;
    for (const client of connectedClients.values().filter((c) => c.connectionStatus === "ready" /* READY */ && !c.dev)) {
      const clusters = this.getClusterForConnection(client);
      const load = clusters.length;
      if (load < lowestLoad) {
        lowestLoad = load;
        lowestLoadClient = client;
      }
    }
    return lowestLoadClient;
  }
  getClusterOfShard(shardID) {
    return this.clusterList.find((c) => c.shardList.includes(shardID));
  }
};

// src/general/ShardingUtil.ts
var ShardingUtil = class {
  static getShardIDForGuild(guildID, totalShards) {
    if (!guildID || totalShards <= 0) {
      throw new Error("Invalid guild ID or total shards");
    }
    return Number(BigInt(guildID) >> 22n) % totalShards;
  }
};

// src/bridge/Bridge.ts
var Bridge = class {
  port;
  server;
  connectedClients = /* @__PURE__ */ new Map();
  token;
  intents;
  shardsPerCluster = 1;
  clusterToStart = 1;
  reclusteringTimeoutInMs;
  clusterCalculator;
  eventMap = {
    CLUSTER_READY: void 0,
    CLUSTER_HEARTBEAT_FAILED: void 0,
    CLUSTER_STOPPED: void 0,
    CLIENT_CONNECTED: void 0,
    CLIENT_DISCONNECTED: void 0,
    CLUSTER_SPAWNED: void 0,
    CLUSTER_RECLUSTER: void 0,
    ERROR: void 0,
    CLIENT_STOP: void 0
  };
  constructor(port, token, intents, shardsPerCluster, clusterToStart, reclusteringTimeoutInMs) {
    this.port = port;
    this.token = token;
    this.intents = intents;
    this.clusterToStart = clusterToStart;
    this.shardsPerCluster = shardsPerCluster;
    this.reclusteringTimeoutInMs = reclusteringTimeoutInMs;
    this.clusterCalculator = new ClusterCalculator(this.clusterToStart, this.shardsPerCluster);
    this.server = new Server({
      port: this.port
    });
  }
  start() {
    this.server.start().then(() => {
      this.startListening();
    });
    this.interval();
  }
  interval() {
    setInterval(() => {
      this.checkCreate();
      this.checkRecluster();
      this.heartbeat();
    }, 5e3);
  }
  checkRecluster() {
    const up = this.clusterCalculator.checkAllClustersConnected();
    if (!up) {
      return;
    }
    const connectedClients = this.connectedClients.values().filter((c) => c.connectionStatus == "ready" /* READY */).filter((c) => !c.dev).filter((c) => c.establishedAt + this.reclusteringTimeoutInMs < Date.now()).toArray();
    const { most, least } = this.clusterCalculator.findMostAndLeastClustersForConnections(connectedClients);
    if (most) {
      const clusterToSteal = this.clusterCalculator.getClusterForConnection(most)[0] || void 0;
      if (least && clusterToSteal) {
        clusterToSteal.reclustering(least);
        if (this.eventMap.CLUSTER_RECLUSTER) this.eventMap.CLUSTER_RECLUSTER(clusterToSteal, least, clusterToSteal.oldConnection);
        this.createCluster(least, clusterToSteal, true);
        return;
      }
    }
  }
  heartbeat() {
    const clusters = this.clusterCalculator.clusterList;
    clusters.forEach((cluster) => {
      if (cluster.connection && cluster.connectionStatus == "connected" /* CONNECTED */ && !cluster.heartbeatPending) {
        cluster.heartbeatPending = true;
        cluster.connection.eventManager.request({
          type: "CLUSTER_HEARTBEAT",
          data: {
            clusterID: cluster.clusterID
          }
        }, 2e4).then((r) => {
          cluster.removeMissedHeartbeat();
          cluster.heartbeatResponse = r;
        }).catch((err) => {
          if (this.eventMap.CLUSTER_HEARTBEAT_FAILED) this.eventMap.CLUSTER_HEARTBEAT_FAILED(cluster, err);
          cluster.addMissedHeartbeat();
          if (cluster.missedHeartbeats > 7 && !cluster.connection?.dev) {
            cluster.connection?.eventManager.send({
              type: "CLUSTER_STOP",
              data: {
                id: cluster.clusterID
              }
            });
            cluster.connectionStatus = "disconnected" /* DISCONNECTED */;
            cluster.resetMissedHeartbeats();
          }
        }).finally(() => {
          cluster.heartbeatPending = false;
        });
      }
    });
  }
  checkCreate() {
    const optionalCluster = this.clusterCalculator.getNextCluster();
    if (!optionalCluster) {
      return;
    }
    const lowestLoadClient = this.clusterCalculator.getClusterWithLowestLoad(this.connectedClients);
    if (!lowestLoadClient) {
      return;
    }
    this.createCluster(lowestLoadClient, optionalCluster);
  }
  createCluster(connection, cluster, recluster = false) {
    cluster.resetMissedHeartbeats();
    cluster.heartbeatResponse = void 0;
    if (!recluster) {
      cluster.setConnection(connection);
    } else {
      cluster.oldConnection?.eventManager.send({
        type: "CLUSTER_RECLUSTER",
        data: {
          clusterID: cluster.clusterID
        }
      });
    }
    if (this.eventMap.CLUSTER_SPAWNED) this.eventMap.CLUSTER_SPAWNED(cluster, connection);
    connection.eventManager.send({
      type: "CLUSTER_CREATE",
      data: {
        clusterID: cluster.clusterID,
        instanceID: connection.instanceID,
        totalShards: this.getTotalShards(),
        shardList: cluster.shardList,
        token: this.token,
        intents: this.intents
      }
    });
  }
  startListening() {
    this.server.on("connect", (connection, payload) => {
      const id = payload?.id;
      const data = payload.data;
      const dev = payload?.dev || false;
      if (!id) {
        connection.close("Invalid payload", false);
        return;
      }
      if (this.connectedClients.values().some((client) => client.instanceID === id)) {
        connection.close("Already connected", false);
        return;
      }
      const bridgeConnection = new BridgeClientConnection(payload.id, connection, data, dev);
      if (this.eventMap.CLIENT_CONNECTED) this.eventMap.CLIENT_CONNECTED(bridgeConnection);
      bridgeConnection.onMessage((m2) => {
        if (m2.type == "CLUSTER_SPAWNED") {
          const cluster = this.clusterCalculator.getClusterForConnection(bridgeConnection).find((c) => c.clusterID === m2.data.id);
          if (cluster) {
            cluster.connectionStatus = "starting" /* STARTING */;
          }
          return;
        }
        if (m2.type == "CLUSTER_READY") {
          const cluster = this.clusterCalculator.getClusterForConnection(bridgeConnection).find((c) => c.clusterID === m2.data.id);
          if (cluster) {
            cluster.startedAt = Date.now();
            if (this.eventMap.CLUSTER_READY) this.eventMap.CLUSTER_READY(cluster, m2.data.guilds || 0, m2.data.members || 0);
            cluster.connectionStatus = "connected" /* CONNECTED */;
            if (cluster.oldConnection) {
              cluster.oldConnection.eventManager.send({
                type: "CLUSTER_STOP",
                data: {
                  id: cluster.clusterID
                }
              });
              cluster.oldConnection = void 0;
            }
          }
          return;
        }
        if (m2.type == "CLUSTER_STOPPED") {
          const cluster = this.clusterCalculator.getClusterForConnection(bridgeConnection).find((c) => c.clusterID === m2.data.id);
          if (cluster) {
            cluster.startedAt = void 0;
            if (this.eventMap.CLUSTER_STOPPED) this.eventMap.CLUSTER_STOPPED(cluster);
            cluster.setConnection(void 0);
          }
          return;
        }
        if (m2.type == "INSTANCE_STOP") {
          this.stopInstance(bridgeConnection);
        }
        return;
      });
      bridgeConnection.onRequest((m2) => {
        if (m2.type == "REDIRECT_REQUEST_TO_GUILD") {
          const guildID = m2.guildID;
          const shardID = ShardingUtil.getShardIDForGuild(guildID, this.getTotalShards());
          const cluster = this.clusterCalculator.getClusterOfShard(shardID);
          if (!cluster) {
            return Promise.reject(new Error("cluster not found"));
          }
          if (cluster.connectionStatus != "connected" /* CONNECTED */) {
            return Promise.reject(new Error("cluster not connected."));
          }
          if (!cluster.connection?.eventManager) {
            return Promise.reject(new Error("no connection defined."));
          }
          return cluster.connection.eventManager.request({
            type: "REDIRECT_REQUEST_TO_GUILD",
            clusterID: cluster.clusterID,
            guildID,
            data: m2.data
          }, 5e3);
        }
        if (m2.type == "BROADCAST_EVAL") {
          const responses = Promise.all(
            this.connectedClients.values().map((c) => {
              return c.eventManager.request({
                type: "BROADCAST_EVAL",
                data: m2.data
              }, 5e3);
            })
          );
          return new Promise((resolve, reject) => {
            responses.then((r) => {
              resolve(r.flatMap((f) => f));
            }).catch(reject);
          });
        }
        if (m2.type == "SELF_CHECK") {
          return {
            clusterList: [
              ...this.clusterCalculator.getClusterForConnection(bridgeConnection).map((c) => c.clusterID),
              ...this.clusterCalculator.getOldClusterForConnection(bridgeConnection).map((c) => c.clusterID)
            ]
          };
        }
        return Promise.reject(new Error("unknown type"));
      });
      this.connectedClients.set(connection.id, bridgeConnection);
    });
    this.server.on("disconnect", (connection, reason) => {
      const closedConnection = this.connectedClients.get(connection.id);
      if (!closedConnection) {
        return;
      }
      const clusters = this.clusterCalculator.getClusterForConnection(closedConnection);
      for (const cluster of clusters) {
        this.clusterCalculator.clearClusterConnection(cluster.clusterID);
      }
      this.connectedClients.delete(connection.id);
      if (this.eventMap.CLIENT_DISCONNECTED) this.eventMap.CLIENT_DISCONNECTED(closedConnection, reason);
    });
    this.server.on("message", (message2, connection) => {
      this.sendMessageToClient(connection.id, message2);
    });
  }
  sendMessageToClient(clientId, message2) {
    if (!this.connectedClients.has(clientId)) {
      return;
    }
    const client = this.connectedClients.get(clientId);
    if (client) {
      client.messageReceive(message2);
    }
  }
  getTotalShards() {
    return this.shardsPerCluster * this.clusterToStart;
  }
  on(event, listener) {
    this.eventMap[event] = listener;
  }
  getClusters() {
    return this.clusterCalculator.clusterList;
  }
  async stopAllInstances() {
    const instances = Array.from(this.connectedClients.values());
    for (const instance of instances) {
      instance.connectionStatus = "pending_stop" /* PENDING_STOP */;
    }
    for (const instance of instances) {
      await this.stopInstance(instance, false);
    }
  }
  async stopAllInstancesWithRestart() {
    const instances = Array.from(this.connectedClients.values());
    for (const instance of instances) {
      await this.stopInstance(instance);
      await new Promise((resolve) => {
        setTimeout(async () => {
          resolve();
        }, 1e3 * 10);
      });
    }
  }
  async moveCluster(instance, cluster) {
    cluster.reclustering(instance);
    this.createCluster(instance, cluster, true);
  }
  async stopInstance(instance, recluster = true) {
    if (this.eventMap.CLIENT_STOP) this.eventMap.CLIENT_STOP(instance);
    instance.connectionStatus = "pending_stop" /* PENDING_STOP */;
    let clusterToSteal;
    await instance.eventManager.send({
      type: "INSTANCE_STOP"
    });
    if (recluster) {
      while ((clusterToSteal = this.clusterCalculator.getClusterForConnection(instance).filter((c) => c.connectionStatus === "connected" /* CONNECTED */ || c.connectionStatus == "starting" /* STARTING */ || c.connectionStatus == "reclustering" /* RECLUSTERING */)[0]) !== void 0) {
        if (clusterToSteal.connectionStatus != "connected" /* CONNECTED */) break;
        const least = this.clusterCalculator.getClusterWithLowestLoad(this.connectedClients);
        if (!least) {
          if (this.eventMap.ERROR) {
            this.eventMap.ERROR("Reclustering failed: No least cluster found.");
          }
          await instance.eventManager.send({
            type: "CLUSTER_STOP",
            data: {
              id: clusterToSteal.clusterID
            }
          });
          clusterToSteal.connection = void 0;
          clusterToSteal.connectionStatus = "disconnected" /* DISCONNECTED */;
          continue;
        }
        clusterToSteal.reclustering(least);
        if (this.eventMap.CLUSTER_RECLUSTER) {
          this.eventMap.CLUSTER_RECLUSTER(clusterToSteal, least, clusterToSteal.oldConnection);
        }
        this.createCluster(least, clusterToSteal, true);
      }
      return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
          const cluster = this.clusterCalculator.getOldClusterForConnection(instance)[0] || void 0;
          if (!cluster) {
            clearInterval(interval);
            await instance.eventManager.send({
              type: "INSTANCE_STOPPED"
            });
            await instance.connection.close("Instance stopped.", false);
            resolve();
            return;
          }
        }, 1e3);
      });
    } else {
      for (const cluster of this.clusterCalculator.getClusterForConnection(instance)) {
        await instance.eventManager.send({
          type: "CLUSTER_STOP",
          data: {
            id: cluster.clusterID
          }
        });
      }
      await instance.eventManager.send({
        type: "INSTANCE_STOPPED"
      });
      await instance.connection.close("Instance stopped.", false);
    }
  }
  sendRequestToGuild(cluster, guildID, data, timeout = 5e3) {
    if (!cluster.connection) {
      return Promise.reject(new Error("No connection defined for cluster " + cluster.clusterID));
    }
    return cluster.connection.eventManager.request({
      type: "REDIRECT_REQUEST_TO_GUILD",
      clusterID: cluster.clusterID,
      guildID,
      data
    }, timeout);
  }
};

// src/cluster/Cluster.ts
import os from "os";
var Cluster = class _Cluster {
  instanceID;
  clusterID;
  shardList = [];
  totalShards;
  token;
  intents;
  eventManager;
  client;
  onSelfDestruct;
  eventMap = {
    message: void 0,
    request: void 0,
    CLUSTER_READY: void 0
  };
  constructor(instanceID, clusterID, shardList, totalShards, token, intents) {
    this.instanceID = instanceID;
    this.clusterID = clusterID;
    this.shardList = shardList;
    this.totalShards = totalShards;
    this.token = token;
    this.intents = intents;
    this.eventManager = new EventManager((message2) => {
      return new Promise((resolve, reject) => {
        if (typeof process.send !== "function") {
          reject(new Error("Process does not support sending messages"));
          return;
        }
        process.send?.(message2, void 0, void 0, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }, (message2) => {
      this._onMessage(message2);
    }, (message2) => {
      return this._onRequest(message2);
    });
    process.on("message", (message2) => {
      this.eventManager.receive(message2);
    });
  }
  static initial() {
    const args = process.env;
    if (args.SHARD_LIST == void 0 || args.INSTANCE_ID == void 0 || args.TOTAL_SHARDS == void 0 || args.TOKEN == void 0 || args.INTENTS == void 0 || args.CLUSTER_ID == void 0) {
      throw new Error("Missing required environment variables");
    }
    const shardList = args.SHARD_LIST.split(",").map(Number);
    const totalShards = Number(args.TOTAL_SHARDS);
    const instanceID = Number(args.INSTANCE_ID);
    const clusterID = Number(args.CLUSTER_ID);
    const token = args.TOKEN;
    const intents = args.INTENTS.split(",").map((i) => i.trim());
    return new _Cluster(instanceID, clusterID, shardList, totalShards, token, intents);
  }
  triggerReady(guilds, members) {
    this.eventManager.send({
      type: "CLUSTER_READY",
      id: this.clusterID,
      guilds,
      members
    });
    if (this.eventMap?.CLUSTER_READY) {
      this.eventMap?.CLUSTER_READY();
    }
  }
  triggerError(e) {
    this.eventManager.send({
      type: "CLUSTER_ERROR",
      id: this.clusterID
    });
  }
  async wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  _onMessage(message2) {
    const m2 = message2;
    if (m2.type == "CUSTOM" && this.eventMap.message) {
      this.eventMap.message(m2.data);
    }
  }
  _onRequest(message) {
    const m = message;
    if (m.type == "CUSTOM" && this.eventMap.request) {
      return new Promise((resolve, reject) => {
        this.eventMap.request(m.data, resolve, reject);
      });
    } else if (m.type == "CLUSTER_HEARTBEAT") {
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
      const cpuPercent = totalCPUTime / (elapsedTimeUs * cpuCount) * 100;
      let shardPings = [];
      try {
        const shards = this.client.ws.shards;
        if (shards) {
          shards.forEach((shard) => {
            shardPings.push({
              id: shard.id,
              ping: shard.ping,
              status: shard.status,
              guilds: this.client.guilds.cache.filter((g) => g.shardId === shard.id).size,
              members: this.client.guilds.cache.filter((g) => g.shardId === shard.id).reduce((acc, g) => acc + g.memberCount, 0)
            });
            this.client.shard?.fetchClientValues("uptime", shard.id).then((values) => {
              shardPings[shard.id]["uptime"] = values;
              console.log(values);
            }).catch((e) => {
            });
          });
        }
      } catch (_) {
      }
      return {
        cpu: { raw: process.cpuUsage(), cpuPercent: cpuPercent.toFixed(2) },
        memory: {
          raw: process.memoryUsage(),
          memoryPercent: (process.memoryUsage().heapUsed / process.memoryUsage().heapTotal * 100).toFixed(2) + "%",
          usage: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + "MB"
        },
        ping: this.client.ws.ping,
        shardPings
      };
    } else if (m.type == "BROADCAST_EVAL") {
      const broadcast = message;
      const fn = eval(`(${broadcast.data})`);
      const result = fn(this.client);
      if (result instanceof Promise) {
        return new Promise((resolve, reject) => {
          result.then((res) => {
            resolve(res);
          }).catch((err) => {
            reject(err);
          });
        });
      } else {
        return result;
      }
    } else if (m.type == "SELF_DESTRUCT") {
      if (this.onSelfDestruct) {
        this.onSelfDestruct();
      }
    }
    return void 0;
  }
  on(event, listener) {
    this.eventMap[event] = listener;
  }
  sendMessage(data) {
    this.eventManager.send({
      type: "CUSTOM",
      data
    });
  }
  sendRequest(data, timeout = 5e3) {
    return this.eventManager.request({
      type: "CUSTOM",
      data
    }, timeout);
  }
  broadcastEval(fn2, timeout = 2e4) {
    return this.eventManager.request({
      type: "BROADCAST_EVAL",
      data: fn2.toString()
    }, timeout);
  }
  sendMessageToClusterOfGuild(guildID, message2) {
    if (this.eventManager) {
      this.eventManager.send({
        type: "REDIRECT_MESSAGE_TO_GUILD",
        guildID,
        data: message2
      });
    }
  }
  sendRequestToClusterOfGuild(guildID, message2, timeout = 5e3) {
    return new Promise((resolve, reject) => {
      if (this.eventManager) {
        this.eventManager.request({
          type: "REDIRECT_REQUEST_TO_GUILD",
          guildID,
          data: message2
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
};

// src/cluster/ClusterProcess.ts
var ClusterProcess = class {
  child;
  eventManager;
  id;
  shardList;
  totalShards;
  status;
  createdAt = Date.now();
  _onMessage;
  _onRequest;
  constructor(id, child, shardList, totalShards) {
    this.id = id;
    this.child = child;
    this.shardList = shardList;
    this.totalShards = totalShards;
    this.status = "starting";
    this.eventManager = new EventManager((message2) => {
      return new Promise((resolve, reject) => {
        this.child.send(message2, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }, (message2) => {
      if (this._onMessage) {
        this._onMessage(message2);
      }
    }, (message2) => {
      if (this._onRequest) {
        return this._onRequest(message2);
      }
      return void 0;
    });
    this.child.on("message", (message2) => {
      this.eventManager.receive(message2);
    });
    this.child.on("exit", () => {
      this.eventManager.close("child process exited");
    });
    this.child.on("error", () => {
      this.eventManager.close("child process error");
    });
  }
  onMessage(callback) {
    this._onMessage = callback;
  }
  onRequest(callback) {
    this._onRequest = callback;
  }
  sendMessage(data) {
    this.eventManager.send({
      type: "CUSTOM",
      data
    });
  }
  sendRequest(data, timeout = 5e3) {
    return this.eventManager.request({
      type: "CUSTOM",
      data
    }, timeout);
  }
};

// src/instance/BotInstance.ts
import { fork } from "child_process";
var BotInstance = class {
  entryPoint;
  execArgv;
  clients = /* @__PURE__ */ new Map();
  constructor(entryPoint, execArgv) {
    this.entryPoint = entryPoint;
    this.execArgv = execArgv ?? [];
  }
  eventMap = {
    "message": void 0,
    "request": void 0,
    "PROCESS_KILLED": void 0,
    "PROCESS_SELF_DESTRUCT_ERROR": void 0,
    "PROCESS_SPAWNED": void 0,
    "ERROR": void 0,
    "PROCESS_ERROR": void 0,
    "CLUSTER_READY": void 0,
    "CLUSTER_ERROR": void 0,
    "CLUSTER_RECLUSTER": void 0,
    "BRIDGE_CONNECTION_ESTABLISHED": void 0,
    "BRIDGE_CONNECTION_CLOSED": void 0,
    "BRIDGE_CONNECTION_STATUS_CHANGE": void 0,
    "INSTANCE_STOP": void 0,
    "INSTANCE_STOPPED": void 0,
    "SELF_CHECK_SUCCESS": void 0,
    "SELF_CHECK_ERROR": void 0,
    "SELF_CHECK_RECEIVED": void 0
  };
  startProcess(instanceID, clusterID, shardList, totalShards, token, intents) {
    try {
      const child = fork(this.entryPoint, {
        env: {
          INSTANCE_ID: instanceID.toString(),
          CLUSTER_ID: clusterID.toString(),
          SHARD_LIST: shardList.join(","),
          TOTAL_SHARDS: totalShards.toString(),
          TOKEN: token,
          INTENTS: intents.join(","),
          FORCE_COLOR: "true"
        },
        stdio: "inherit",
        execArgv: this.execArgv,
        silent: false,
        detached: true
      });
      const client = new ClusterProcess(clusterID, child, shardList, totalShards);
      child.stdout?.on("data", (data) => {
        process.stdout.write(data);
      });
      child.stderr?.on("data", (data) => {
        process.stderr.write(data);
      });
      child.on("spawn", () => {
        if (this.eventMap.PROCESS_SPAWNED) this.eventMap.PROCESS_SPAWNED(client);
        this.setClusterSpawned(client);
        this.clients.set(clusterID, client);
        client.onMessage((message2) => {
          this.onMessage(client, message2);
        });
        client.onRequest((message2) => {
          return this.onRequest(client, message2);
        });
      });
      child.on("error", (err) => {
        if (this.eventMap.PROCESS_ERROR) this.eventMap.PROCESS_ERROR(client, err);
      });
      child.on("exit", (err) => {
        if (client.status !== "stopped") {
          client.status = "stopped";
          this.killProcess(client, `Process exited: ${err?.message}`);
        }
      });
    } catch (error) {
      throw new Error(`Failed to start process for cluster ${clusterID}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  killProcess(client, reason) {
    client.status = "stopped";
    client.eventManager.request({
      type: "SELF_DESTRUCT",
      reason
    }, 5e3).catch(() => {
      if (this.eventMap.PROCESS_SELF_DESTRUCT_ERROR) this.eventMap.PROCESS_SELF_DESTRUCT_ERROR(client, reason, "Cluster didnt respond to shot-call.");
    }).finally(() => {
      if (client.child && client.child.pid) {
        if (client.child.kill("SIGKILL")) {
          if (this.eventMap.PROCESS_KILLED) this.eventMap.PROCESS_KILLED(client, reason, true);
        } else {
          if (this.eventMap.ERROR) this.eventMap.ERROR(`Failed to kill process for cluster ${client.id}`);
          client.child.kill("SIGKILL");
        }
        try {
          process.kill(-client.child.pid);
        } catch {
        }
      } else {
        if (this.eventMap.PROCESS_KILLED) this.eventMap.PROCESS_KILLED(client, reason, false);
      }
      this.clients.delete(client.id);
      this.setClusterStopped(client, reason);
    });
  }
  onMessage(client, message2) {
    if (message2.type === "CLUSTER_READY") {
      client.status = "running";
      if (this.eventMap.CLUSTER_READY) this.eventMap.CLUSTER_READY(client);
      this.setClusterReady(client, message2.guilds || 0, message2.members || 0);
    }
    if (message2.type === "CLUSTER_ERROR") {
      client.status = "stopped";
      if (this.eventMap.CLUSTER_ERROR) this.eventMap.CLUSTER_ERROR(client, message2.error);
      this.killProcess(client, "Cluster error: " + message2.error);
    }
    if (message2.type == "CUSTOM" && this.eventMap.message) {
      this.eventMap.message(client, message2.data);
    }
  }
  on(event, listener) {
    this.eventMap[event] = listener;
  }
  sendRequestToClusterOfGuild(guildID, message2, timeout = 5e3) {
    return new Promise((resolve, reject) => {
      for (const client of this.clients.values()) {
        const shardID = ShardingUtil.getShardIDForGuild(guildID, client.totalShards);
        if (client.shardList.includes(shardID)) {
          client.eventManager.request({
            type: "CUSTOM",
            data: message2
          }, timeout).then(resolve).catch(reject);
          return;
        }
      }
      reject(new Error(`No cluster found for guild ${guildID}`));
    });
  }
  sendRequestToCluster(cluster, message2, timeout = 5e3) {
    return new Promise((resolve, reject) => {
      cluster.eventManager.request({
        type: "CUSTOM",
        data: message2
      }, timeout).then(resolve).catch(reject);
      return;
    });
  }
};

// src/instance/ManagedInstance.ts
import { Client } from "net-ipc";
var BridgeConnectionStatus = /* @__PURE__ */ ((BridgeConnectionStatus2) => {
  BridgeConnectionStatus2[BridgeConnectionStatus2["CONNECTED"] = 0] = "CONNECTED";
  BridgeConnectionStatus2[BridgeConnectionStatus2["DISCONNECTED"] = 1] = "DISCONNECTED";
  return BridgeConnectionStatus2;
})(BridgeConnectionStatus || {});
var ManagedInstance = class extends BotInstance {
  host;
  port;
  instanceID;
  eventManager;
  connectionStatus = 1 /* DISCONNECTED */;
  data;
  dev = false;
  constructor(entryPoint, host, port, instanceID, data, execArgv, dev) {
    super(entryPoint, execArgv);
    this.host = host;
    this.port = port;
    this.instanceID = instanceID;
    this.data = data;
    this.dev = dev || false;
  }
  start() {
    const client = new Client({
      host: this.host,
      port: this.port,
      reconnect: true,
      retries: 100
    });
    this.eventManager = new EventManager((message2) => {
      if (client.status == 3) {
        return client.send(message2);
      }
      return Promise.reject(new Error("Client is not ready to send messages"));
    }, (message2) => {
      const m2 = message2;
      if (m2.type == "CLUSTER_CREATE") {
        this.onClusterCreate(m2.data);
      } else if (m2.type == "CLUSTER_STOP") {
        this.onClusterStop(m2.data);
      } else if (m2.type == "CLUSTER_RECLUSTER") {
        this.onClusterRecluster(m2.data);
      } else if (m2.type == "INSTANCE_STOP") {
        if (this.eventMap.INSTANCE_STOP) {
          this.eventMap.INSTANCE_STOP();
        }
      } else if (m2.type == "INSTANCE_STOPPED") {
        if (this.eventMap.INSTANCE_STOPPED) {
          this.eventMap.INSTANCE_STOPPED();
        }
      }
    }, (message2) => {
      return this.onBridgeRequest(message2);
    });
    setInterval(() => {
      if (this.connectionStatus == 0 /* CONNECTED */) {
        this.selfCheck();
      }
    }, 2500);
    client.connect({
      id: this.instanceID,
      dev: this.dev,
      data: this.data
    }).then((_) => {
      if (this.eventMap.BRIDGE_CONNECTION_ESTABLISHED) this.eventMap.BRIDGE_CONNECTION_ESTABLISHED();
      this.connectionStatus = 0 /* CONNECTED */;
      client.on("message", (message2) => {
        this.eventManager?.receive(message2);
      });
      client.on("close", (reason) => {
        if (this.eventMap.BRIDGE_CONNECTION_CLOSED) this.eventMap.BRIDGE_CONNECTION_CLOSED(reason);
        if (this.connectionStatus == 0 /* CONNECTED */) {
          this.clients.forEach((client2) => {
            this.killProcess(client2, "Bridge connection closed");
          });
        }
        this.connectionStatus = 1 /* DISCONNECTED */;
      });
      client.on("status", (status) => {
        if (this.eventMap.BRIDGE_CONNECTION_STATUS_CHANGE) this.eventMap.BRIDGE_CONNECTION_STATUS_CHANGE(status);
        if (status == 4) {
          if (this.connectionStatus == 0 /* CONNECTED */) {
            this.clients.forEach((client2) => {
              this.killProcess(client2, "Bridge connection closed");
            });
          }
          this.connectionStatus = 1 /* DISCONNECTED */;
        } else if (status == 3) {
          this.connectionStatus = 0 /* CONNECTED */;
          if (this.eventMap.BRIDGE_CONNECTION_ESTABLISHED) this.eventMap.BRIDGE_CONNECTION_ESTABLISHED();
        }
      });
    });
  }
  selfCheck() {
    this.eventManager.request({
      type: "SELF_CHECK"
    }, 1e3 * 60).then((r) => {
      const response = r;
      if (this.eventMap.SELF_CHECK_RECEIVED) {
        this.eventMap.SELF_CHECK_RECEIVED(response);
      }
      const startingClusters = this.clients.values().filter((c) => c.status == "starting").toArray();
      startingClusters.forEach((c) => {
        if (Date.now() - c.createdAt > 10 * 60 * 1e3) {
          this.killProcess(c, "Cluster took too long to start");
        }
      });
      const wrongClusters = this.clients.values().filter((c) => !response.clusterList.includes(c.id)).toArray();
      if (wrongClusters.length > 0) {
        if (this.eventMap.SELF_CHECK_ERROR) {
          this.eventMap.SELF_CHECK_ERROR(`Self check found wrong clusters: ${wrongClusters.map((c) => c.id).join(", ")}`);
        }
        wrongClusters.forEach((c) => {
          this.killProcess(c, "Self check found wrong cluster");
        });
      } else {
        if (this.eventMap.SELF_CHECK_SUCCESS) {
          this.eventMap.SELF_CHECK_SUCCESS();
        }
      }
    }).catch((err) => {
      if (this.eventMap.SELF_CHECK_ERROR) {
        this.eventMap.SELF_CHECK_ERROR(`Self check failed: ${err}`);
      }
    });
  }
  setClusterStopped(client, reason) {
    this.eventManager?.send({
      type: "CLUSTER_STOPPED",
      data: {
        id: client.id,
        reason
      }
    }).catch(() => {
      return null;
    });
  }
  setClusterReady(client, guilds, members) {
    this.eventManager?.send({
      type: "CLUSTER_READY",
      data: {
        id: client.id,
        guilds,
        members
      }
    });
  }
  setClusterSpawned(client) {
    this.eventManager?.send({
      type: "CLUSTER_SPAWNED",
      data: {
        id: client.id
      }
    });
  }
  onClusterCreate(message2) {
    const m2 = message2;
    if (this.clients.has(m2.clusterID)) {
      this.eventManager?.send({
        type: "CLUSTER_STOPPED",
        data: {
          id: m2.clusterID,
          reason: "Cluster already exists"
        }
      }).catch(() => {
        return null;
      });
      return;
    }
    this.startProcess(this.instanceID, m2.clusterID, m2.shardList, m2.totalShards, m2.token, m2.intents);
  }
  onClusterStop(message2) {
    const m2 = message2;
    const cluster = this.clients.get(m2.id);
    if (cluster) {
      this.killProcess(cluster, `Request to stop cluster ${m2.id}`);
    }
  }
  onClusterRecluster(message2) {
    const m2 = message2;
    const cluster = this.clients.get(m2.clusterID);
    if (this.eventMap.CLUSTER_RECLUSTER && cluster) {
      this.eventMap.CLUSTER_RECLUSTER(cluster);
    }
  }
  onRequest(client, message2) {
    if (message2.type === "REDIRECT_REQUEST_TO_GUILD") {
      const guildID = message2.guildID;
      const data = message2.data;
      const shardID = ShardingUtil.getShardIDForGuild(guildID, client.totalShards);
      if (client.shardList.includes(shardID)) {
        return client.eventManager.request({
          type: "CUSTOM",
          data
        }, 5e3);
      } else {
        return this.eventManager.request({
          type: "REDIRECT_REQUEST_TO_GUILD",
          guildID,
          data
        }, 5e3);
      }
    }
    if (message2.type == "BROADCAST_EVAL") {
      return this.eventManager.request({
        type: "BROADCAST_EVAL",
        data: message2.data
      }, 5e3);
    }
    if (message2.type == "CUSTOM" && this.eventMap.request) {
      return new Promise((resolve, reject) => {
        this.eventMap.request(client, message2.data, resolve, reject);
      });
    }
    return Promise.reject(new Error(`Unknown request type: ${message2.type}`));
  }
  onBridgeRequest(message2) {
    if (message2.type === "REDIRECT_REQUEST_TO_GUILD") {
      const clusterID = message2.clusterID;
      const data = message2.data;
      const cluster = this.clients.get(clusterID);
      if (cluster) {
        return cluster.eventManager.request({
          type: "CUSTOM",
          data
        }, 5e3);
      } else {
        return Promise.reject(new Error(`Cluster is not here. Cluster ID: ${clusterID}`));
      }
    } else if (message2.type == "CLUSTER_HEARTBEAT") {
      const clusterID = message2.data.clusterID;
      const cluster = this.clients.get(clusterID);
      if (cluster) {
        return new Promise((resolve, reject) => {
          cluster.eventManager.request({
            type: "CLUSTER_HEARTBEAT"
          }, 15e3).then((r) => {
            resolve(r);
          }).catch((err) => {
            reject(err);
          });
        });
      } else {
        return Promise.reject(new Error(`Cluster is not here. Cluster ID: ${clusterID}`));
      }
    } else if (message2.type == "BROADCAST_EVAL") {
      return Promise.all(this.clients.values().filter((c) => c.status == "running").map((c) => {
        return c.eventManager.request({
          type: "BROADCAST_EVAL",
          data: message2.data
        }, 5e3);
      }));
    }
    return Promise.reject(new Error(`Unknown request type: ${message2.type}`));
  }
  stopInstance() {
    this.eventManager?.send({
      type: "INSTANCE_STOP"
    });
  }
};

// src/instance/StandaloneInstance.ts
var StandaloneInstance = class extends BotInstance {
  totalClusters;
  shardsPerCluster;
  token;
  intents;
  constructor(entryPoint, shardsPerCluster, totalClusters, token, intents, execArgv) {
    super(entryPoint, execArgv);
    this.shardsPerCluster = shardsPerCluster;
    this.totalClusters = totalClusters;
    this.token = token;
    this.intents = intents;
  }
  get totalShards() {
    return this.shardsPerCluster * this.totalClusters;
  }
  calculateClusters() {
    const clusters = {};
    for (let i = 0; i < this.totalClusters; i++) {
      clusters[i] = [];
      for (let j = 0; j < this.shardsPerCluster; j++) {
        clusters[i].push(i * this.shardsPerCluster + j);
      }
    }
    return clusters;
  }
  start() {
    const clusters = this.calculateClusters();
    for (const [id, shardList] of Object.entries(clusters)) {
      this.startProcess(1, Number(id), shardList, this.totalShards, this.token, this.intents);
    }
  }
  setClusterStopped(client, reason) {
    this.clients.delete(client.id);
    this.restartProcess(client);
  }
  setClusterReady(client) {
  }
  setClusterSpawned(client) {
  }
  restartProcess(client) {
    this.startProcess(1, client.id, client.shardList, this.totalShards, this.token, this.intents);
  }
  onRequest(client, message2) {
    if (message2.type === "REDIRECT_REQUEST_TO_GUILD") {
      const guildID = message2.guildID;
      const data = message2.data;
      const shardID = ShardingUtil.getShardIDForGuild(guildID, client.totalShards);
      if (client.shardList.includes(shardID)) {
        return client.eventManager.request({
          type: "CUSTOM",
          data
        }, 5e3);
      } else {
        return Promise.reject(new Error(`Shard ID ${shardID} not found in cluster ${client.id} for guild ${guildID}`));
      }
    }
    if (message2.type == "BROADCAST_EVAL") {
      return Promise.all(
        this.clients.values().map((c) => {
          return c.eventManager.request({
            type: "BROADCAST_EVAL",
            data: message2.data
          }, 5e3);
        })
      );
    }
    if (message2.type == "CUSTOM" && this.eventMap.request) {
      return new Promise((resolve, reject) => {
        this.eventMap.request(client, message2.data, resolve, reject);
      });
    }
    return Promise.reject(new Error(`Unknown request type: ${message2.type}`));
  }
};
export {
  BotInstance,
  Bridge,
  BridgeClientCluster,
  BridgeClientClusterConnectionStatus,
  BridgeClientConnection,
  BridgeClientConnectionStatus,
  BridgeConnectionStatus,
  Cluster,
  ClusterCalculator,
  ClusterProcess,
  EventManager,
  ManagedInstance,
  ShardingUtil,
  StandaloneInstance
};
//# sourceMappingURL=index.mjs.map