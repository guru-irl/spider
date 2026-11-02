// SPDX-License-Identifier: MIT
import type { HcClient, HerdrConfig, MachineName, MachineSummary } from '@spider/herdr';
import { HerdrError } from '@spider/herdr/client/parse';

type ConfiguredMachine = HerdrConfig['machines'][number];
const key = (name: string) => name.toLowerCase();

export async function resolveMachine(hc: Pick<HcClient, 'machines'>, configured: HerdrConfig['machines'], requested: string): Promise<{ machine: ConfiguredMachine; on: MachineName }> {
  const inventory = await hc.machines();
  const rows = configured.map(machine => {
    const exact = inventory.filter(item => key(item.name) === key(machine.name));
    const linked = exact.length ? exact : inventory.filter(item => [machine.name, ...machine.aliases].some(alias => [item.name, ...item.aliases].some(name => key(name) === key(alias))));
    const live: MachineSummary | undefined = linked.length === 1 ? linked[0] : undefined;
    const aliases = [...new Set([machine.name, ...machine.aliases, ...(live ? [live.name, ...live.aliases] : [])])];
    return { machine, live, aliases, ambiguous: linked.length > 1 };
  });
  const matches = rows.filter(row => row.aliases.some(alias => key(alias) === key(requested)));
  if (matches.length === 1 && !matches[0].ambiguous) return { machine: matches[0].machine, on: matches[0].live?.name ?? matches[0].machine.name };
  const listing = rows.map(row => `${row.machine.name}${row.aliases.length > 1 ? ` (aliases: ${row.aliases.filter(alias => key(alias) !== key(row.machine.name)).join(', ')})` : ''}`).join('; ') || 'none';
  const reason = matches.length > 1 || matches[0]?.ambiguous ? 'Destination is ambiguous' : 'Destination is not configured';
  throw new HerdrError(matches.length > 1 || matches[0]?.ambiguous ? 'machine-ambiguous' : 'machine-unconfigured', `${reason}: ${JSON.stringify(requested)}. Configured machines: ${listing}`);
}
