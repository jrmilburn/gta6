// Mirroring an animation clip left-to-right.
//
// Mixamo authors one diagonal, not two: "Jog Forward Diagonal" travels forward
// and to one side, and there is no download for the other side. Rather than ask
// for a second file -- or play the wrong one and hope -- the clip is reflected
// across the character's own YZ plane, which is exactly the operation that
// turns a right diagonal into a left one.
//
// Three things have to happen together, and doing any two of them is worse than
// doing none: the left and right bones swap names, translations negate their X,
// and rotations negate their Y and Z. That last one is the standard result for
// reflecting a rotation about the plane x = 0 -- a reflection is not a rotation,
// so the handedness has to come back somewhere, and it comes back in the pair
// of sign flips.
import * as THREE from 'three';

/** `mixamorig9LeftArm` <-> `mixamorig9RightArm`, in one pass so it swaps. */
function swapSide(name: string): string {
  if (name.includes('Left')) return name.replace('Left', 'Right');
  if (name.includes('Right')) return name.replace('Right', 'Left');
  return name;
}

/**
 * A mirrored copy of `clip`, renamed with a `:mirror` suffix.
 *
 * The result is a genuine clip in its own right: same duration, same bones,
 * same root motion reflected. Feeding it to a mixer costs no more than the
 * original.
 */
export function mirrorClip(clip: THREE.AnimationClip): THREE.AnimationClip {
  const out = clip.clone();
  out.name = `${clip.name}:mirror`;
  for (const track of out.tracks) {
    const dot = track.name.lastIndexOf('.');
    const bone = track.name.slice(0, dot);
    const property = track.name.slice(dot);
    track.name = swapSide(bone) + property;

    const v = track.values;
    if (property === '.position') {
      for (let i = 0; i < v.length; i += 3) v[i] = -v[i];
    } else if (property === '.quaternion') {
      for (let i = 0; i < v.length; i += 4) { v[i + 1] = -v[i + 1]; v[i + 2] = -v[i + 2]; }
    }
    // Scale is symmetric under this reflection, and nothing in the set animates
    // it anyway.
  }
  // The tracks are no longer in bone order after the swap, which three does not
  // require but which makes a mixer's bindings easier to read in a debugger.
  out.tracks.sort((a, b) => a.name.localeCompare(b.name));
  out.resetDuration();
  return out;
}
