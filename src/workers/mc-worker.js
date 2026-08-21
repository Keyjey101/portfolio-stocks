// Worker Монте-Карло: три симуляции (×0.5/×1/×2 довнесений) вне основного потока
const { parentPort, workerData } = require('worker_threads');
const { simulateMC } = require('../lab/mc');

const { pools, A, pi, years, monthlyUsd, startValue, paths, seed } = workerData;
const mk = m => simulateMC({ pools, A, pi, years, monthlyUsd: monthlyUsd * m, startValue, paths, seed });

parentPort.postMessage({ base: mk(1), half: mk(0.5), double: mk(2) });
