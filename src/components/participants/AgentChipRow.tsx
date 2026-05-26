import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';

import AgentChip from './AgentChip';
import type { SessionAgent } from './types';

type AgentChipRowProps = {
  agents: SessionAgent[];
  // Models first, then by invocation count desc; remaining collapse to "+N".
  max?: number;
  t: TFunction;
  className?: string;
};

/** Models (agent_kind='model') first, then by invocation_count descending. */
function orderAgents(agents: SessionAgent[]): SessionAgent[] {
  return [...agents].sort((a, b) => {
    const modelA = a.agent_kind === 'model' ? 1 : 0;
    const modelB = b.agent_kind === 'model' ? 1 : 0;
    if (modelA !== modelB) {
      return modelB - modelA;
    }
    return b.invocation_count - a.invocation_count;
  });
}

export default function AgentChipRow({ agents, max = 3, t, className }: AgentChipRowProps) {
  if (agents.length === 0) {
    return null;
  }

  const ordered = orderAgents(agents);
  const visible = ordered.slice(0, max);
  const overflow = ordered.slice(max);

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {visible.map((agent) => (
        <AgentChip key={`${agent.agent_kind}:${agent.agent_name}`} agent={agent} t={t} />
      ))}
      {overflow.length > 0 && (
        <Tooltip
          content={
            <span className="flex flex-col gap-0.5 text-start">
              {overflow.map((agent) => (
                <span key={`${agent.agent_kind}:${agent.agent_name}`}>
                  {agent.agent_name} ({agent.invocation_count})
                </span>
              ))}
            </span>
          }
        >
          <span className="inline-flex items-center rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
            +{overflow.length}
          </span>
        </Tooltip>
      )}
    </div>
  );
}
