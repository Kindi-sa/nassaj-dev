import { Bot, Wrench } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';

import type { SessionAgent } from './types';
import { shortAgentName } from './utils';

type AgentChipProps = {
  agent: SessionAgent;
  t: TFunction;
};

export default function AgentChip({ agent, t }: AgentChipProps) {
  const isModel = agent.agent_kind === 'model';
  const Icon = isModel ? Bot : Wrench;
  const kindLabel = t(`participants.agentKinds.${agent.agent_kind}`, {
    defaultValue: agent.agent_kind,
  });

  const tooltipContent = (
    <span className="flex flex-col gap-0.5 text-start">
      <span className="font-semibold">{agent.agent_name}</span>
      <span className="opacity-80">{kindLabel}</span>
      <span className="opacity-70">
        {t('participants.invocations', {
          count: agent.invocation_count,
          defaultValue: '{{count}} invocations',
        })}
      </span>
    </span>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span
        className={cn(
          'inline-flex max-w-[7.5rem] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none',
          isModel
            ? 'border-primary/30 bg-primary/10 text-primary'
            : 'border-border bg-muted/60 text-muted-foreground',
        )}
        aria-label={`${agent.agent_name} — ${kindLabel}`}
      >
        <Icon className="h-3 w-3 flex-shrink-0" aria-hidden />
        <span className="truncate">{shortAgentName(agent.agent_name)}</span>
        {agent.invocation_count > 1 && (
          <span className="flex-shrink-0 opacity-70">{agent.invocation_count}</span>
        )}
      </span>
    </Tooltip>
  );
}
