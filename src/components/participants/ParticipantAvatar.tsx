import { useState } from 'react';
import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';

import type { SessionParticipant } from './types';
import { avatarColorForUser, formatLastSeen, initialForName } from './utils';

type SizeToken = 'xs' | 'sm';

const SIZE_CLASSES: Record<SizeToken, string> = {
  // 20px stacked avatars (project-level, denser).
  xs: 'h-5 w-5 text-[9px]',
  // 24px stacked avatars (session row / header).
  sm: 'h-6 w-6 text-[10px]',
};

type ParticipantAvatarProps = {
  participant: SessionParticipant;
  size?: SizeToken;
  locale: string;
  t: TFunction;
  // When true, render a subtle ring/badge to mark the project/session owner.
  stacked?: boolean;
  // Optional profile picture. When present (and it loads), it replaces the
  // coloured initial circle. On load failure we fall back to initial + colour.
  avatarUrl?: string;
};

function roleLabel(role: string, t: TFunction): string {
  return t(`participants.roles.${role}`, { defaultValue: role });
}

export default function ParticipantAvatar({
  participant,
  size = 'sm',
  locale,
  t,
  stacked = true,
  avatarUrl,
}: ParticipantAvatarProps) {
  const lastSeen = formatLastSeen(participant.last_seen, locale);

  // Track image load failure so we can fall back to the coloured initial.
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(avatarUrl) && !imageFailed;

  const tooltipContent = (
    <span className="flex flex-col gap-0.5 text-start">
      <span className="font-semibold">{participant.username}</span>
      <span className="opacity-80">{roleLabel(participant.role, t)}</span>
      {lastSeen && (
        <span className="opacity-70">
          {t('participants.lastSeen', { defaultValue: 'Last seen' })}: {lastSeen}
        </span>
      )}
    </span>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span
        role="img"
        aria-label={`${participant.username} — ${roleLabel(participant.role, t)}`}
        className={cn(
          'relative inline-flex select-none items-center justify-center overflow-hidden rounded-full font-semibold text-white',
          SIZE_CLASSES[size],
          // Only paint the deterministic colour when no image is shown.
          !showImage && avatarColorForUser(participant.userId),
          stacked && '-ms-1.5 first:ms-0',
        )}
      >
        {showImage ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          initialForName(participant.username)
        )}
      </span>
    </Tooltip>
  );
}
