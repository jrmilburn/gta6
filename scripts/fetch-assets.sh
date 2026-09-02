#!/usr/bin/env bash
# Fetch every CC0 asset the game uses into public/assets/.
#
#   ./scripts/fetch-assets.sh          # fetch anything missing
#   ./scripts/fetch-assets.sh --force  # re-fetch everything
#
# Reproducible by construction: Kenney's download URLs carry a content hash that
# changes on every re-release, so the kit page is scraped for the current one
# rather than a URL being pinned here and rotting. Poly Haven is resolved through
# its public API for the same reason. Every source is CC0; see ASSETS.md.
#
# ambientCG's 1K-JPG bundles are already 1024 px, but they ship at JPEG quality
# ~100: a single normal map is 2 MB, and the eight materials together came to
# 20 MB. They are re-encoded to WebP here (~9x smaller, visually identical on a
# tiled surface), which is what keeps the cold load inside its budget. ffmpeg is
# used if present and skipped if not -- the committed assets mean a plain clone
# never needs it. Kenney's GLBs already embed their small palette texture, and
# the HDRIs are taken at 1K (see ASSETS.md for why 1K and not 2K).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/assets"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
have() { [ "$FORCE" -eq 0 ] && [ -s "$1" ]; }

fetch() { # url dest
  curl -sSL --retry 3 --retry-delay 2 --max-time 300 -o "$2" "$1"
}

mkdir -p "$OUT"/{hdri,models/cars,models/nature,models/props,textures}

# --- Poly Haven HDRIs -------------------------------------------------------
#
# DECISION: 1K, not the 2K the brief suggests. The HDRI is only ever consumed
# through PMREMGenerator, whose output cube is 256 px; 2K quadruples the
# download (5.7 MB -> 1.4 MB each) for an environment map that is identical
# after prefiltering. The visible sky is the existing tinted dome, not this.
hdri() { # slug
  local dest="$OUT/hdri/$1_1k.hdr"
  have "$dest" && { say "hdri $1 (cached)"; return; }
  say "hdri $1"
  local url
  url=$(curl -sSL --max-time 60 "https://api.polyhaven.com/files/$1" \
    | tr ',' '\n' | grep -o 'https://[^"]*/hdr/1k/[^"]*\.hdr' | head -1)
  [ -n "$url" ] || { echo "  ! no 1k hdr for $1"; return; }
  fetch "$url" "$dest"
}

hdri venice_sunset
hdri the_sky_is_on_fire

# --- Kenney kits ------------------------------------------------------------
#
# Only the handful of GLBs the game actually instances are kept; a whole kit is
# 3-10 MB of models the world never places.
kenney() { # slug  dest-dir  file...
  local slug="$1" dir="$2"; shift 2
  local zip="$TMP/$slug.zip"
  local missing=0
  for f in "$@"; do have "$dir/$f.glb" || missing=1; done
  [ "$missing" -eq 0 ] && { say "kenney/$slug (cached)"; return; }

  say "kenney/$slug"
  local url
  url=$(curl -sSL --max-time 60 "https://kenney.nl/assets/$slug" \
    | grep -o "https://kenney\.nl/media/pages/assets/[^']*\.zip" | head -1)
  [ -n "$url" ] || { echo "  ! no download link on the $slug page"; return; }
  fetch "$url" "$zip"
  mkdir -p "$dir"
  for f in "$@"; do
    # Kits vary between "Models/GLB format" and "Models/GLTF format".
    local member
    member=$(unzip -Z1 "$zip" | grep -iE "(GLB|GLTF) format/$f\.glb$" | head -1 || true)
    [ -n "$member" ] || { echo "  ! $f.glb not in $slug"; continue; }
    unzip -p "$zip" "$member" > "$dir/$f.glb"
  done
  # Some kits reference their palette texture from the GLB rather than embedding
  # it; without this the models load with every material untextured and the
  # console fills with "Couldn't load texture Textures/colormap.png".
  local texdir
  # `|| true`: a kit with no external textures makes grep exit 1, which under
  # `set -e` would abort the whole fetch.
  texdir=$(unzip -Z1 "$zip" | grep -iE "(GLB|GLTF) format/Textures/[^/]+\.(png|jpg)$" | head -20 || true)
  if [ -n "$texdir" ]; then
    mkdir -p "$dir/Textures"
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      unzip -p "$zip" "$m" > "$dir/Textures/$(basename "$m")"
    done <<< "$texdir"
  fi
  unzip -p "$zip" 'License.txt' > "$dir/LICENSE.txt" 2>/dev/null || true
}

kenney car-kit "$OUT/models/cars" \
  sedan sedan-sports hatchback-sports truck police van suv \
  wheel-default wheel-racing cone box

kenney nature-kit "$OUT/models/nature" \
  tree_palmDetailedTall tree_palmDetailedShort tree_palmBend tree_palmTall \
  tree_oak tree_detailed tree_default tree_fat tree_small \
  plant_bush plant_bushDetailed plant_bushLarge \
  grass grass_large rock_smallA

kenney city-kit-suburban "$OUT/models/props" \
  fence fence-low planter tree-small

# --- ambientCG PBR textures -------------------------------------------------
#
# Each bundle ships Color / NormalGL / Roughness / AmbientOcclusion /
# Displacement at 1K. Only the first three are used; the rest are dropped so the
# repo does not carry 2x the bytes it renders.
acg() { # assetId  local-name
  local id="$1" name="$2"
  local dir="$OUT/textures/$name"
  if have "$dir/color.webp" && have "$dir/normal.webp" && have "$dir/rough.webp"; then
    say "acg/$id -> $name (cached)"; return
  fi
  say "acg/$id -> $name"
  local zip="$TMP/$id.zip"
  fetch "https://ambientcg.com/get?file=${id}_1K-JPG.zip" "$zip"
  mkdir -p "$dir"
  pick() { # suffix dest
    local m
    m=$(unzip -Z1 "$zip" | grep -iE "_$1\.jpg$" | head -1 || true)
    [ -n "$m" ] || { echo "  ! no $1 map in $id"; return; }
    unzip -p "$zip" "$m" > "$dir/$2"
  }
  pick Color color.jpg
  pick NormalGL normal.jpg
  pick Roughness rough.jpg
  squash "$dir"
}

# WebP re-encode. Normals carry direction in their chroma so they get the most
# quality; roughness is a single channel dressed up as RGB and gets the least.
HAVE_FFMPEG=0
command -v ffmpeg >/dev/null 2>&1 && HAVE_FFMPEG=1
squash() { # dir
  [ "$HAVE_FFMPEG" -eq 1 ] || { echo "  (no ffmpeg: keeping full-size JPEG)"; return; }
  local dir="$1"
  for pair in color.jpg:82 normal.jpg:85 rough.jpg:70; do
    local f="${pair%%:*}" q="${pair##*:}"
    [ -s "$dir/$f" ] || continue
    ffmpeg -hide_banner -loglevel error -y -i "$dir/$f"       -c:v libwebp -quality "$q" -compression_level 6 "$dir/${f%.jpg}.webp"
    rm -f "$dir/$f"
  done
}

acg Concrete034         concrete
acg Plaster001          stucco-a
acg PaintedPlaster017   stucco-b
acg Bricks097           brick
acg Asphalt031          asphalt
acg PavingStones131     pavement
acg Ground093A          sand
acg CorrugatedSteel009  roof-metal

# --- report -----------------------------------------------------------------
say "public/assets is now $(du -sh "$OUT" | cut -f1)"
find "$OUT" -type f | wc -l | xargs printf '    %s files\n'
