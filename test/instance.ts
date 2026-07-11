import { ManagedInstance2 } from "../src";

import dotenv from "dotenv";

dotenv.config();

const instance = new ManagedInstance2(
  `${__dirname}/cluster.ts`,
  "localhost",
  3000,
  1,
  {
    key: "value",
  },
  ["--import", "tsx"],
  false,
);

instance.start();

instance.on("BRIDGE_CONNECTION_ESTABLISHED", () => {
  console.log("Bridge connected");
});

instance.on("CLUSTER_READY", () => {
  console.log("ready");
});

instance.on("CLUSTER_RECLUSTER", (client) => {
  console.error("Cluster reclustered", client.id);
});

instance.on("CLUSTER_ERROR", (error) => {
  console.error("Cluster error", error);
});

instance.on("ERROR", (error) => {
  console.error("Error in instance", error);
});

instance.on("PROCESS_SPAWNED", (r) => {
  console.log("Process spawned", r.id);
});

instance.on("PROCESS_KILLED", (r, reason) => {
  console.log("Process killed", r.id, reason);
});

instance.on("PROCESS_ERROR", (r, error) => {
  console.error("Process error", r.id, error);
});

instance.on("BRIDGE_CONNECTION_CLOSED", (r) => {
  console.log("Bridge connection closed", r);
});

instance.on("INSTANCE_STOP", () => {
  console.log("Instance stop requested");
});

instance.on("SELF_CHECK_SUCCESS", () => {
  console.log("Self check successful");
});

instance.on("SELF_CHECK_ERROR", (error) => {
  console.error("Self check failed", error);
});

// on command input

process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", async function (text: Buffer) {
  const input = text.toString().trim();

  if (input == "test") {
    instance
      .sendRequestToClusterOfGuild("1297244911787311104", {
        test: "CLI",
      })
      .then((result) => {
        console.log(result);
      })
      .catch((err) => {
        console.error(err);
      });
  } else if (input == "stop") {
    instance.stopInstance();
  }
});

process.on("beforeExit", () => {});
