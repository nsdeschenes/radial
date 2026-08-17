function deterministicPermutation<Value>(
  values: readonly Value[],
  permutation: number
): Value[] {
  const offset = permutation % values.length;
  const rotated = [...values.slice(offset), ...values.slice(0, offset)];
  return permutation % 2 === 0 ? rotated : rotated.reverse();
}

export default deterministicPermutation;
