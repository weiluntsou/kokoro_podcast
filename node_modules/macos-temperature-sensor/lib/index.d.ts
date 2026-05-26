// index.d.ts

export function version(): string;

export interface TemperatureReading {
	cpu: number | null;
	soc: number;
	gpu: number | null;
	cpuDieTemps: number[];
	probeGroupsTemps: number[];
	gpuDieTemps: number[];
}

export function temperature(): TemperatureReading;
