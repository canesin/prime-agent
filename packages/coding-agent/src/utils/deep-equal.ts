/**
 * Structural equality for JSON-shaped values.
 *
 * Object key order does not matter, and keys whose value is undefined are
 * ignored, matching JSON serialization. Arrays are order-sensitive.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((item, index) => deepEqual(item, right[index]));
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
	const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((key) => rightKeys.includes(key) && deepEqual(leftRecord[key], rightRecord[key]));
}
