import {Cluster} from "../src";
import {Client, ClientOptions} from "discord.js";

export class ExtendedClient extends Client {
     cluster: Cluster<ExtendedClient>;

     constructor(options: ClientOptions, cluster: Cluster<ExtendedClient>) {
          super(options);
          this.cluster = cluster;
     }

}

const cluster = Cluster.initial<ExtendedClient>();

const client = new ExtendedClient({
     shards: cluster.shardList,
     shardCount: cluster.totalShards,
     intents: cluster.intents,
}, cluster);
cluster.client = client;
client.login(cluster.token).then(r => {
     cluster.triggerReady(client.guilds.cache.size, client.guilds.cache.values().map(g => g.memberCount).reduce((a, b) => a + b, 0));

     // set status
     client.user?.setPresence({
          status: "online",
          activities: [{
               name:  cluster.clusterID + "/" + cluster.instanceID
          }],
          shardId: cluster.shardList
     })
}).catch(e => {
     console.error('Failed to login:', e);
     cluster.triggerError(e);
})

cluster.on('message', (message) => {

})

cluster.on('request', (message, resolve, reject) => {
     resolve({"no": "No"});
})