/**
 * Small async helpers. Pure — unit tested in async.test.ts.
 */

/**
 * Maps over items with a bounded number of concurrent workers. Used when resolving track metadata so a
 * 500 track artist does not fire 500 store lookups at once.
 */
export const mapWithConcurrency = async <T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> => {
	const results: R[] = new Array(items.length);
	if (items.length === 0) return results;

	let cursor = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await mapper(items[index], index);
		}
	});

	await Promise.all(workers);
	return results;
};

export const chunk = <T>(items: T[], size: number): T[][] => {
	if (size <= 0) return [items];
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
};
