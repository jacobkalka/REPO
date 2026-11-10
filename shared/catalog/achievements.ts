// Achievement metadata. Conditions are evaluated on the server (server/src/economy/achievements.ts).

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  reward: number;   // credits
  xp: number;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_haul', name: 'First Haul', description: 'Complete your first successful extraction.', reward: 500, xp: 200 },
  { id: 'heavy_lifter', name: 'Heavy Lifter', description: 'Extract a single item weighing over 60 kg.', reward: 900, xp: 300 },
  { id: 'many_hands', name: 'Many Hands', description: 'Carry one object together with two teammates.', reward: 700, xp: 250 },
  { id: 'medic', name: 'Field Medic', description: 'Revive 5 teammates.', reward: 1200, xp: 400 },
  { id: 'close_call', name: 'Close Call', description: 'Extract with less than 15 health.', reward: 800, xp: 300 },
  { id: 'ghost', name: 'Ghost Shift', description: 'Complete a mission without being spotted by any creature.', reward: 1500, xp: 500 },
  { id: 'big_score', name: 'Big Score', description: 'Bank 50,000 credits of salvage in a single mission.', reward: 2500, xp: 700 },
  { id: 'millionaire', name: 'Career Salvager', description: 'Recover 1,000,000 credits of salvage in total.', reward: 10000, xp: 2000 },
  { id: 'black_contract', name: 'Black Contract', description: 'Succeed on Black Contract difficulty.', reward: 5000, xp: 1500 },
  { id: 'tour', name: 'Tour of Duty', description: 'Succeed at all four facilities.', reward: 3000, xp: 1000 },
  { id: 'archivist', name: 'Archivist', description: 'Read 25 recovered documents.', reward: 1500, xp: 500 },
  { id: 'steady_hands', name: 'Steady Hands', description: 'Extract an extremely fragile item without a scratch.', reward: 900, xp: 300 },
  { id: 'unknown', name: 'Seen It', description: 'Survive a mission in which the Visitor appeared.', reward: 3000, xp: 900 },
  { id: 'streak5', name: 'Overtime Regular', description: 'Reach a five-contract streak.', reward: 2000, xp: 600 },
  { id: 'lights_on', name: 'Lights On', description: 'Restore power 10 times.', reward: 700, xp: 250 },
  { id: 'pneumatic', name: 'Pneumatic Pro', description: 'Send 50 items up the cargo tubes.', reward: 900, xp: 300 },
  { id: 'seasoned', name: 'Seasoned', description: 'Reach level 10.', reward: 2000, xp: 0 },
  { id: 'veteran', name: 'Veteran', description: 'Reach level 25.', reward: 6000, xp: 0 },
  { id: 'not_today', name: 'Not Today', description: 'Stun creatures 20 times.', reward: 1000, xp: 350 },
  { id: 'last_standing', name: 'Last One Standing', description: 'Extract alone after the rest of the crew went down.', reward: 1500, xp: 500 },
];

export const ACHIEVEMENT_BY_ID: Record<string, AchievementDef> = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
