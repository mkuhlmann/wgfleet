const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;

	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	return `${Math.round(value * 100) / 100} ${units[unitIndex]}`;
};
