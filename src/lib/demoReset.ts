import { forgetMat } from '../mat/lib/matStore';
import { saveWoundOpacity } from './woundOpacity';
import { resetAllXRPrefs } from './xrPrefs';

/**
 * Reset demo: forgets everything the headset experience remembers between
 * sessions, so the next one starts from the very beginning (trace the mat,
 * meet Buddy) with default settings, as for a new user:
 *
 *   - the saved mat (its persistent anchor is deleted when the next session starts) and its opacity,
 *   - the wound's opacity,
 *   - the headset settings (wound hand, skin tone, labels, Buddy, colours…).
 *
 * Panel places, Buddy's spot and the introduction last only for a session anyway.
 */
export function resetDemo() {
  forgetMat();
  saveWoundOpacity(1);
  resetAllXRPrefs();
}
