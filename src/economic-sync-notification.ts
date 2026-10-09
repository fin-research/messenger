type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}
const gapReasons = new Set(['not_returned', 'invalid_code', 'source_returned_empty', 'stored_fields_incomplete',
  'source_fields_incomplete', 'outside_daily_window', 'observation_absent', 'report_not_uploaded']);

/** Only explicitly classified, completed economic-sync results qualify.
 * Unknown/legacy failures remain failures; platform errors take precedence. */
export function economicSyncHasOnlyDataGaps(output: unknown): boolean {
  const root = record(output);
  if (!root || root.status !== 'partial') return false;
  const quant = record(root.quant);
  const nodes = [root, ...(quant ? [quant] : []),
    ...[root.groups, quant?.groups].flatMap(groups => Array.isArray(groups) ? groups.map(record) : [])];
  let evidence = false;
  for (const node of nodes) {
    if (!node || ['failed', 'not_found'].includes(String(node.status))) return false;
    if (node.error || node.message || (node.errors && (!Array.isArray(node.errors) || node.errors.length))) return false;
    if (node.failures !== undefined && !Array.isArray(node.failures)) return false;
    const failures = Array.isArray(node.failures) ? node.failures : [];
    if (failures.some(failure => record(failure)?.kind !== 'data_gap')) return false;
    if (node.status !== 'partial') continue;
    const missing = Array.isArray(node.missing) ? node.missing : [];
    if (missing.some(gap => !gapReasons.has(String(record(gap)?.reason)))) return false;
    const localEvidence = failures.length > 0 || missing.length > 0;
    evidence ||= localEvidence;
    const childPartial = record(node.quant)?.status === 'partial' ||
      (Array.isArray(node.groups) && node.groups.some(group => record(group)?.status === 'partial'));
    if (!localEvidence && !childPartial) return false;
  }
  return evidence;
}

const reasonLabels: Record<string, string> = {
  not_returned: '来源未返回', invalid_code: '无效代码', source_returned_empty: '来源返回空数据',
  stored_fields_incomplete: '已存字段不全', source_fields_incomplete: '来源字段不全',
  outside_daily_window: '历史待补', observation_absent: '尚未落库', report_not_uploaded: '报告尚未上传',
};

export function economicSyncGapSummary(output: unknown): string {
  const root = record(output), quant = record(root?.quant);
  const groups = Array.isArray(root?.groups) ? root.groups : Array.isArray(quant?.groups) ? quant.groups : [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const value of groups.slice(0, 20)) {
    const group = record(value);
    if (!group || group.status !== 'partial' || !Array.isArray(group.missing) || !group.missing.length) continue;
    const name = String(group.name ?? '数据来源');
    if (seen.has(name)) continue;
    seen.add(name);
    const reasons = new Map<string, Set<string>>(), dates = new Set<string>(), codes = new Set<string>();
    for (const raw of group.missing) {
      const gap = record(raw);
      if (!gap) continue;
      const reason = reasonLabels[String(gap.reason)] ?? '数据待补';
      const gapDates = Array.isArray(gap.dates) ? gap.dates.map(String) : [];
      const gapCodes = Array.isArray(gap.codes) ? gap.codes.map(String) : [];
      gapDates.forEach(date => dates.add(date)); gapCodes.forEach(code => codes.add(code));
      const entries = reasons.get(reason) ?? new Set<string>();
      entries.add(JSON.stringify([gap.source, gapDates, gapCodes])); reasons.set(reason, entries);
    }
    const samples = [dates.size ? `日期 ${[...dates].sort().slice(0, 3).join('、')}${dates.size > 3 ? '等' : ''}` : '',
      codes.size ? `债券 ${[...codes].sort().slice(0, 3).join('、')}${codes.size > 3 ? '等' : ''}` : ''].filter(Boolean);
    lines.push(`${name}：${[...reasons].map(([reason, entries]) => `${reason} ${entries.size} 项`).join('；')}${samples.length ? `（${samples.join('，')}）` : ''}`);
  }
  if (!lines.length) {
    const failures = [root, quant, ...groups.map(record)].flatMap(node =>
      Array.isArray(node?.failures) ? node.failures : []);
    const details = new Set<string>();
    for (const value of failures) {
      const failure = record(value);
      if (failure?.kind !== 'data_gap') continue;
      details.add(`${String(failure.source ?? '数据来源').slice(0, 120)}：${String(failure.error ?? '数据待补').slice(0, 240)}`);
      if (details.size >= 10) break;
    }
    lines.push(...details);
  }
  return lines.join('\n');
}
