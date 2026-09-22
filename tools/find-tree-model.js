/**
 * Is there a tree-crown model on Replicate we could call per address?
 *
 * WHAT THIS DECIDES. The plan is to hand a tracer every tree crown on the lot
 * as its own toggle -- on means grass underneath, off means ignore it -- which
 * turns the slowest part of tracing a wooded lawn into a row of taps. The
 * model that does it exists: restor/tcd-mask-rcnn-r50 on Hugging Face, an
 * instance segmenter trained on 10 cm imagery, which is our own resolution
 * (H1). See E5 and E8 in docs/DETECTOR-FINDINGS.md.
 *
 * What is NOT settled is where it runs. The Worker is a V8 isolate; it cannot
 * host a PyTorch Mask R-CNN, and Workers AI is a catalogue you pick from
 * rather than somewhere to upload one. So the model runs somewhere else and is
 * called -- and the two somewhere-elses have very different costs:
 *
 *   ON REPLICATE, if it is already published there, it is a fetch away and
 *   works for any address a visitor types. It also costs money per prediction,
 *   on top of SAM, for ever.
 *
 *   IN CI, over the lawns already sitting in the queue, it is free and
 *   instant at tracing time -- but only for lawns somebody screened in
 *   advance, which is the tracing flow and not the public one.
 *
 * This answers the first half. If nothing is published, the fallback is not
 * "abandon it": it is push a cog of the Hugging Face weights, or precompute.
 * Knowing which is a two minute question and building the wrong one is a day.
 *
 * FREE. Reads model metadata only and never starts a prediction.
 *
 *   REPLICATE_TOKEN=r8_... node tools/find-tree-model.js
 *
 * or, the way anybody actually runs it, workflow "18. Find a tree crown model".
 */

const token = process.env.REPLICATE_TOKEN;
if (!token) {
  console.error('FAIL  Needs REPLICATE_TOKEN.');
  process.exit(1);
}
const auth = { Authorization: `Bearer ${token}` };

/**
 * Named guesses, checked whether or not the search works.
 *
 * Replicate's search has failed silently before -- it uses the HTTP QUERY
 * verb, which not every proxy passes -- and an empty result would otherwise
 * read as "nothing exists" rather than "nothing was asked". These are the
 * slugs worth trying by hand if that happens.
 */
const CANDIDATES = [
  'restor/tcd',
  'restor/tcd-mask-rcnn',
  'restor/tree-crown-delineation',
  'jqueguiner/tree-detection',
  'deepforest/deepforest',
  'weecology/deepforest',
];

/**
 * What a useful answer looks like.
 *
 * INSTANCE, NOT SEMANTIC, is the whole point and the easiest thing to get
 * wrong here. A tree/no-tree mask is one blob over a row of touching trees;
 * what the toggles need is each crown as its own object. Restor publish both
 * kinds under names that differ by four characters, so the words are worth
 * looking for rather than assuming.
 */
const INSTANCE_WORDS = /instance|mask.?r.?cnn|crown|individual|delineat|detect/i;
const TREE_WORDS = /tree|canopy|crown|forest|vegetation/i;

async function getModel(slug) {
  try {
    const res = await fetch(`https://api.replicate.com/v1/models/${slug}`, { headers: auth });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { model: await res.json() };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 60) };
  }
}

/** Replicate's search is the QUERY verb with a plain-text body. */
async function search(term) {
  try {
    const res = await fetch('https://api.replicate.com/v1/models', {
      method: 'QUERY',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: term,
    });
    if (!res.ok) return { ok: false, hits: [] };
    const data = await res.json();
    return {
      ok: true,
      hits: (data.results || []).map((m) => ({
        slug: `${m.owner}/${m.name}`,
        description: String(m.description || ''),
      })),
    };
  } catch {
    return { ok: false, hits: [] };
  }
}

const TERMS = [
  'tree crown delineation aerial',
  'individual tree detection segmentation',
  'tree canopy segmentation satellite',
  'instance segmentation aerial imagery trees',
  'deepforest tree crown',
];

console.log('Searching Replicate for a tree-crown model…\n');

let searchWorked = false;
const seen = new Map();
for (const term of TERMS) {
  const { ok, hits } = await search(term);
  searchWorked = searchWorked || ok;
  console.log(`  "${term}" -> ${ok ? `${hits.length} hits` : 'search unavailable'}`);
  for (const h of hits) if (!seen.has(h.slug)) seen.set(h.slug, h.description);
}

if (!searchWorked) {
  console.log('\n(the search endpoint did not answer -- only the named guesses below '
    + 'were checked, so "nothing found" would mean nothing was asked)');
}

/* The interesting ones first: anything whose name or blurb mentions trees. */
const treeish = [...seen.entries()].filter(([slug, d]) => TREE_WORDS.test(`${slug} ${d}`));
console.log(`\n${seen.size} distinct models returned, ${treeish.length} of them about trees.\n`);

const checked = [];
for (const [slug, description] of [
  ...treeish,
  ...CANDIDATES.filter((c) => !seen.has(c)).map((c) => [c, '']),
]) {
  const { model, error } = await getModel(slug);
  if (error) {
    console.log(`  ✗ ${slug.padEnd(40)} ${error}`);
    continue;
  }
  const blurb = String(model.description || description || '');
  const version = model.latest_version;
  const fields = Object.keys(version?.openapi_schema?.components?.schemas?.Input?.properties || {});
  const instance = INSTANCE_WORDS.test(`${slug} ${blurb}`);
  console.log(`  ${instance ? '★' : '·'} ${slug.padEnd(40)} ${blurb.slice(0, 60)}`);
  console.log(`      inputs: ${fields.join(', ') || '(no readable schema)'}`);
  checked.push({ slug, blurb, fields, instance, runnable: Boolean(version?.id) });
}

/* ----------------------------------------------------------- the verdict */
/*
 * AT THE BOTTOM, because this project is read from a phone and the list above
 * is thirty lines of slugs. Both branches end in something to do rather than
 * in a fact, because "no model found" is not the end of the idea -- it only
 * decides which of two ways to run it.
 */
const runnable = checked.filter((c) => c.runnable);
const instances = runnable.filter((c) => c.instance);

console.log(`\n${'='.repeat(70)}\n`);
if (instances.length) {
  console.log(`FOUND ${instances.length} that may delineate individual crowns:`);
  for (const c of instances) console.log(`  ${c.slug}`);
  console.log('\nCheck the inputs above take an image and return per-instance masks,');
  console.log('not a single tree/no-tree raster. Restor publish both kinds and their');
  console.log('names differ by four characters.');
  console.log('\nIf one holds up, the crowns can be fetched per address like SAM is,');
  console.log('and it costs money per prediction like SAM does.');
} else if (runnable.length) {
  console.log(`${runnable.length} tree-ish models are runnable, but none looks like an`);
  console.log('INSTANCE segmenter. A tree/no-tree raster is one blob over a row of');
  console.log('touching trees, which is not what a per-crown toggle needs.');
} else {
  console.log('NOTHING PUBLISHED that does this.');
}

if (!instances.length) {
  console.log('\nThat does not end the idea. Two ways left, and the second is free:');
  console.log('');
  console.log('  1. Push a cog of restor/tcd-mask-rcnn-r50 to Replicate. On demand,');
  console.log('     works for any address a visitor types, costs per prediction.');
  console.log('  2. Run it in CI over the lawns already in the queue and store the');
  console.log('     crowns on the row. Free, instant when the tracer opens the lawn,');
  console.log('     no new dependency in the Worker -- and only for lawns somebody');
  console.log('     screened in advance, so not the public "measure my address" flow.');
  console.log('');
  console.log('Option 2 also answers whether the idea is any good before a penny is');
  console.log('spent on option 1.');
}
console.log(`\n${'='.repeat(70)}`);
