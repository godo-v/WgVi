// Dog profile: owner-entered details that personalise the analysis.
// WagVitals' app asks owners for their dog's weight and turns it into exercise
// recommendations; the planned smart bed will supply weight automatically
// (protocol message "W").

import { SIZE_PROFILES } from '../config.js';

export const DEFAULT_PROFILE = { name: 'My dog', weightKg: 20, idealWeightKg: null, ageYears: 4 };

export function sizeOf(weightKg) {
  if (weightKg < 10) return 'small';
  if (weightKg <= 25) return 'medium';
  return 'large';
}

// Expected heart rates for this dog. Puppies run faster than adults.
export function vitalsFor(profile) {
  const size = sizeOf(profile.weightKg || DEFAULT_PROFILE.weightKg);
  const base = SIZE_PROFILES[size];
  const puppy = profile.ageYears != null && profile.ageYears < 1;
  return {
    size,
    sizeLabel: base.label,
    restingHr: base.restingHr + (puppy ? 20 : 0),
    restingHrMax: base.restingHrMax + (puppy ? 40 : 0),
    maxHr: base.maxHr + (puppy ? 20 : 0),
  };
}

// Daily activity goal (minutes of walking + running + playing) and tips.
// General guidance only; to be refined with WagVitals' veterinary advisors.
export function activityGoal(profile) {
  const size = sizeOf(profile.weightKg || DEFAULT_PROFILE.weightKg);
  let minutes = SIZE_PROFILES[size].goalMin;
  const tips = [];
  if (profile.ageYears != null && profile.ageYears < 1) {
    minutes = 40;
    tips.push('Puppy: several short play sessions are better than one long run.');
  } else if (profile.ageYears >= 9) {
    minutes = 40;
    tips.push('Senior dog: gentle, regular walks help keep joints moving.');
  }
  if (profile.idealWeightKg && profile.weightKg > profile.idealWeightKg * 1.1) {
    const over = Math.round((profile.weightKg / profile.idealWeightKg - 1) * 100);
    minutes += 15;
    tips.push(`About ${over}% above ideal weight: add a brisk 15-minute walk and ask your vet about portions.`);
  }
  return { minutes, tips };
}
