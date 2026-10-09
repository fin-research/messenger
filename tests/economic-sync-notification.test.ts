import { describe, expect, it } from 'vitest';
import { economicSyncHasOnlyDataGaps, economicSyncGapSummary } from '../src/economic-sync-notification';

function fixture() {
  const groups = [{ name: '同步 Quant 一级市场', status: 'partial',
    failures: [{ source: 'primary-2026-10-02', error: 'No observations returned', kind: 'data_gap' }],
    missing: [{ source: 'primary-2026-10-02', dates: ['2026-10-02'], fields: ['ISSUE_NUM'], reason: 'source_returned_empty' }] },
  { name: '同步 Quant 资金日报', status: 'partial', failures: [],
    missing: [{ source: 'fund-reports/2026-10-09.html', dates: ['2026-10-09'], reason: 'report_not_uploaded' }] }];
  return { status: 'partial', failures: [], groups, quant: { status: 'partial', groups,
    failures: groups.flatMap(group => group.failures), missing: groups.flatMap(group => group.missing) } };
}
describe('economic sync notification classification', () => {
  it('preserves partial results and summarizes classified gaps, including missing-only report', () => {
    const output = fixture();
    expect(economicSyncHasOnlyDataGaps(output)).toBe(true);
    expect(economicSyncGapSummary(output)).toContain('来源返回空数据 1 项');
    expect(economicSyncGapSummary(output)).toContain('报告尚未上传 1 项');
    expect(economicSyncGapSummary(output).split('同步 Quant 一级市场')).toHaveLength(2);
    expect(output.status).toBe('partial');
  });
  it.each(['execution', undefined])('execution and unclassified legacy failures keep their failure semantics: %s', kind => {
    const output = fixture();
    const failure = { source: 'choice', error: 'HTTP 503', ...(kind ? { kind } : {}) };
    expect(economicSyncHasOnlyDataGaps({ ...output, quant: { ...output.quant, failures: [failure] } })).toBe(false);
  });
  it('does not overlook a group execution failure omitted from the outer summary', () => {
    const output = fixture();
    expect(economicSyncHasOnlyDataGaps({ ...output, groups: [...output.groups,
      { name: '数据库', status: 'partial', failures: [{ source: 'database', error: 'write failed', kind: 'execution' }] }] })).toBe(false);
  });
  it('unexplained partial status and old unclassified missing entries cannot become data-gap-only', () => {
    expect(economicSyncHasOnlyDataGaps({ status: 'partial', failures: [] })).toBe(false);
    expect(economicSyncHasOnlyDataGaps({ status: 'partial', failures: [], missing: [{ source: 'report' }] })).toBe(false);
  });
  it('bounds bond examples without omitting the total', () => {
    const output = { status: 'partial', groups: [{ name: '估值', status: 'partial', failures: [],
      missing: Array.from({ length: 2000 }, (_, i) => ({ source: 'bond-history', codes: [`${String(i).padStart(6, '0')}.SH`],
        dates: ['2026-10-08'], reason: 'stored_fields_incomplete' })) }] };
    expect(economicSyncHasOnlyDataGaps(output)).toBe(true);
    const text = economicSyncGapSummary(output);
    expect(text).toContain('已存字段不全 2000 项'); expect(text.length).toBeLessThan(250);
  });
  it('falls back to bounded failure details when no missing list is supplied', () => {
    const output = { status: 'partial', failures: [{ source: 'issue-spread', error: '1 spreads unavailable', kind: 'data_gap' }] };
    expect(economicSyncHasOnlyDataGaps(output)).toBe(true);
    expect(economicSyncGapSummary(output)).toBe('issue-spread：1 spreads unavailable');
  });
});
