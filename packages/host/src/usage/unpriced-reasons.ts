/** Internal SQL column expression only, never request input. Unknown stored
 * reasons must not become public labels, including after future migrations. */
export function unpricedReasonSql(column: string): string {
  return `CASE WHEN ${column} IN ('unknown-model','unsupported-provider','missing-attribution','no-rate-at-time','invalid-usage')
    THEN ${column} ELSE 'unavailable' END`;
}
