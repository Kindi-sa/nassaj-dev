import type { ComponentType } from 'react';
import {
  Minus,
  Gauge,
  Zap,
  Flame,
  Cpu,
  Layers,
  Sparkles,
  Wand2,
} from 'lucide-react';

export type EffortMode = {
  id: string;
  /** Technical value sent as `effort` field. Empty string = no effort field. */
  effortValue: string;
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }> | null;
  color: string;
  /** Intensity level for visual treatment: 0 = none, 1 = light, 2 = medium, 3 = high, 4 = max */
  intensity: 0 | 1 | 2 | 3 | 4;
};

export const effortModes: EffortMode[] = [
  {
    id: 'none',
    effortValue: '',
    name: 'standard',
    description: '',
    icon: Minus,
    color: 'text-gray-400',
    intensity: 0,
  },
  {
    id: 'auto',
    /** Empty string = no effort field sent; model decides autonomously. */
    effortValue: '',
    name: 'auto',
    description: '',
    icon: Wand2,
    color: 'text-gray-500',
    intensity: 1,
  },
  {
    id: 'low',
    effortValue: 'low',
    name: 'low',
    description: '',
    icon: Gauge,
    color: 'text-green-500',
    intensity: 1,
  },
  {
    id: 'medium',
    effortValue: 'medium',
    name: 'medium',
    description: '',
    icon: Zap,
    color: 'text-blue-500',
    intensity: 2,
  },
  {
    id: 'high',
    effortValue: 'high',
    name: 'high',
    description: '',
    icon: Flame,
    color: 'text-indigo-500',
    intensity: 2,
  },
  {
    id: 'xhigh',
    effortValue: 'xhigh',
    name: 'xhigh',
    description: '',
    icon: Cpu,
    color: 'text-purple-500',
    intensity: 3,
  },
  {
    id: 'max',
    effortValue: 'max',
    name: 'max',
    description: '',
    icon: Layers,
    color: 'text-orange-500',
    intensity: 3,
  },
  {
    id: 'ultracode',
    effortValue: 'ultracode',
    name: 'ultracode',
    description: '',
    icon: Sparkles,
    color: 'text-red-500',
    intensity: 4,
  },
];
