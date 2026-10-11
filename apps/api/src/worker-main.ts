import { startScheduler } from "./worker.js";
import { startWorker, stopWorker } from "./lib/jobs.js";
startWorker();
startScheduler();
process.on("SIGTERM", () => { stopWorker(); setTimeout(() => process.exit(0), 5000).unref(); });
