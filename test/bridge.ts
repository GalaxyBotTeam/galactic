import {Bridge} from "../src/bridge/Bridge";

import dotenv from "dotenv";

dotenv.config();


const bridge = new Bridge(3000, process.env.TEST_BOT_TOKEN!, [
    "Guilds"
], 2, 2)

bridge.start();

bridge.connectedClients.values().map(c => c.data);

bridge.on('CLUSTER_READY', (client) => {
    console.log(`Cluster ${client.clusterID} is ready with shards: ${client.shardList.join(', ')}`);
});
bridge.on('CLUSTER_STOPPED', (client) => {
    console.log(`Cluster stopped ${client.clusterID}`);
});

bridge.on('CLUSTER_SPAWNED', (client) => {
    console.log(`Cluster spawned ${client.clusterID}`);
});


process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', async function (text: Buffer) {
    const input = text.toString().trim().split(" ");

    if(input[0] == 'stop'){
        bridge.stopInstance(bridge.connectedClients.values().next().value!).then((result) => {
            console.log("Stopped instance:", result);
        });
    } else if(input[0] == 'move') {
        const instanceID = parseInt(input[1]);
        const clusterID = parseInt(input[2]);

        const instance = bridge.connectedClients.values().find(c => c.instanceID === instanceID);
        const cluster = bridge.getClusters().find(c => c.clusterID === clusterID);
        bridge.moveCluster(instance!, cluster!).then((result) => {
            console.log("Moved cluster:", result);
        }).catch((error) => {
            console.error("Error moving cluster:", error);
        });
    }
});
