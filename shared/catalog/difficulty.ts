export interface DifficultyDef {
  index: number;
  id: string;
  name: string;
  description: string;
  quotaMult: number;
  rewardMult: number;
  monsterBudget: number;
  aggression: number;     // detection + speed multiplier
  eventRate: number;
  hazardDensity: number;
  valuableMult: number;
  unlockLevel: number;
  xpMult: number;
}

export const DIFFICULTIES: DifficultyDef[] = [
  { index: 0, id: 'survey', name: 'Survey', description: 'Lighter quota, fewer creatures. A good first shift.', quotaMult: 0.72, rewardMult: 0.8, monsterBudget: 0.6, aggression: 0.82, eventRate: 0.6, hazardDensity: 0.6, valuableMult: 1.15, unlockLevel: 1, xpMult: 0.8 },
  { index: 1, id: 'contract', name: 'Contract', description: 'The standard job. The company expects you back.', quotaMult: 1.0, rewardMult: 1.0, monsterBudget: 1.0, aggression: 1.0, eventRate: 1.0, hazardDensity: 1.0, valuableMult: 1.0, unlockLevel: 1, xpMult: 1.0 },
  { index: 2, id: 'hazard', name: 'Hazard Pay', description: 'More creatures, sharper senses, bigger quota and much bigger cheques.', quotaMult: 1.3, rewardMult: 1.5, monsterBudget: 1.45, aggression: 1.18, eventRate: 1.3, hazardDensity: 1.3, valuableMult: 1.1, unlockLevel: 4, xpMult: 1.35 },
  { index: 3, id: 'black', name: 'Black Contract', description: 'Off the books. Everything in the building wants you, and the Visitor comes early.', quotaMult: 1.6, rewardMult: 2.2, monsterBudget: 2.0, aggression: 1.4, eventRate: 1.7, hazardDensity: 1.6, valuableMult: 1.2, unlockLevel: 9, xpMult: 1.8 },
];

/** quota / budget scaling by crew size (index = players) */
export const CREW_QUOTA = [1, 0.72, 1.0, 1.24, 1.46];
export const CREW_MONSTERS = [1, 0.68, 1.0, 1.22, 1.42];

export function baseQuota(difficulty: number, crew: number, streak: number): number {
  const d = DIFFICULTIES[Math.max(0, Math.min(3, difficulty))];
  const q = 9000 * d.quotaMult * CREW_QUOTA[Math.max(1, Math.min(4, crew))] * (1 + 0.18 * Math.min(10, streak));
  return Math.round(q / 100) * 100;
}

export function streakRewardMult(streak: number): number {
  return 1 + 0.1 * Math.min(10, streak);
}
