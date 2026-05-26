const lib_version = require("../package.json").version;
const m = require("../build/Release/mac_temp_native.node");
const os = require("os");

const _platform = os.type();
const _darwin = _platform === "Darwin";

function version() {
	return lib_version;
}

function maxTemp(tempArray) {
	let max = -Infinity;
	for (const s of tempArray) {
		if (s > max) max = s;
	}
	return Number.isFinite(max) ? max : null;
}
function avgTemp(tempArray) {
	return tempArray.length
		? tempArray.reduce((a, b) => a + b, 0) / tempArray.length
		: -1;
}

function temperature() {
	if (_darwin) {
		const tdie = []; // CPU
		const tpg = []; // SoC
		const tdev = []; // GPU
		m.snapshot().sensors.forEach((element) => {
			const name = element.name.toLowerCase();
			if (name.startsWith("pmu tdie")) {
				tdie.push(element.tempC);
			}
			if (name.startsWith("pmu tp") && name.endsWith("g")) {
				tpg.push(element.tempC);
			}
			if (name.startsWith("pmu tdev")) {
				tdev.push(element.tempC);
			}
		});
		return {
			cpu: maxTemp(tdie),
			soc: avgTemp(tdie.concat(tpg)),
			gpu: maxTemp(tdev),
			cpuDieTemps: tdie,
			probeGroupsTemps: tpg,
			gpuDieTemps: tdev,
		};
	} else {
		new Error("CPU temperature reading not supported on this platform");
	}
}

exports.version = version;
exports.temperature = temperature;
