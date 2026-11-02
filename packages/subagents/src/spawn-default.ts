import type { Spawner } from './runner';
import { directSpawner } from './spawn-direct';
import { spawnDurableChild } from './durable-child';

export const defaultSpawner: Spawner = spec => spec.supervisor ? spawnDurableChild(spec) : directSpawner(spec);
