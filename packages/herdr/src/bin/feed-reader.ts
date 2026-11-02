// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { runFeedReaderCli } from '../feed/reader.js';
process.exit(await runFeedReaderCli(process.argv.slice(2)));
