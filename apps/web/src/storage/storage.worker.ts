// Thin adapter: the actual worker logic lives in @atlas/storage (rule 1).
import { runStorageWorker } from '@atlas/storage/worker';

runStorageWorker();
