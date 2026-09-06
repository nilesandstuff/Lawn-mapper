/**
 * Finds a segmentation model that accepts point prompts.
 *
 * meta/sam-2 on Replicate is the *automatic* mask generator: its inputs are
 * image, use_m2m, points_per_side, pred_iou_thresh, stability_score_thresh.
 * It segments everything on a grid and has no way to be told "this patch of
 * grass". The whole tap-a-pin design depends on prompting, so we need a model
 * whose schema actually takes points.
 *
 * Free: reads model metadata only, never starts a prediction.
 *
 *   REPLICATE_TOKEN=r8_... node tools/find-sam-model.js
 */

const token = process.env.REPLICATE_TOKEN;
if (!token) {
  console.error('FAIL  Needs REPLICATE_TOKEN.');
  process.exit(1);
}
const auth = { Authorization: `Bearer ${token}` };

/** Fields that mean "you can tell me where to look". */
const POINT_FIELDS = /point_?coords|point_?labels|^points$|click|prompt_?point|coordinates|input_?points/i;
const BOX_FIELDS = /box|bbox/i;
const TEXT_FIELDS = /^(text|prompt|text_prompt|caption)$/i;

/** Models worth checking by name, most promising first. */
const CANDIDATES = [
  'meta/sam-3',
  'meta/sam3',
  'meta/sam-3-image',
  'facebook/sam-3',
  'meta/sam-2',
  'meta/sam-2-video',
  'meta/segment-anything-2',
  'facebookresearch/sam2',
  'lucataco/segment-anything-2',
  'pablodawson/segment-anything-2',
  'schananas/grounded_sam',
  'yyjim/segment-anything-everything',
  'cjwbw/segment-anything',
  'nateraw/segment-anything',
  'lucataco/sam-2',
  'zsxkib/segment-anything-2',
  'ryan5453/segment-anything',
  'daanelson/segment-anything',
  // A second sweep, after the first found only two point-promptable models and
  // neither was a plain SAM 2 image model: meta/sam-2-video wants a video, and
  // ocg2347/sam-pointprompt is an unknown quantity. If a maintained SAM 2 image
  // port with click prompts exists, it is one of these.
  'ocg2347/sam-pointprompt',
  'casia-iva-lab/fastsam',
  'zsxkib/sam-2',
  'zsxkib/sam2-video',
  'meta/sam-2-image',
  'lucataco/segment-anything',
  'schananas/grounded-sam',
  'yorickvp/segment-anything',
  'hieupham1000/sam2-image',
  'adirik/grounding-dino',
  'nateraw/sam-2',
];

/**
 * The full contract for a model worth using.
 *
 * A field name is not enough to build against. "input_points" could be
 * [[x,y]], {x,y}, or a JSON string, and the difference is a failed prediction
 * that costs money to discover. Types, defaults and the model's own
 * descriptions are published; reading them is free and guessing is not.
 */
const DETAIL = (process.env.DETAIL || '').split(',').map((s) => s.trim()).filter(Boolean);

async function getModel(slug) {
  const res = await fetch(`https://api.replicate.com/v1/models/${slug}`, { headers: auth });
  if (!res.ok) return { slug, error: `HTTP ${res.status}` };
  return { slug, model: await res.json() };
}

function describe(model) {
  const v = model.latest_version;
  const props = v?.openapi_schema?.components?.schemas?.Input?.properties;
  if (!props) return { runnable: !!v?.id, fields: null };

  const fields = Object.keys(props);
  return {
    runnable: !!v.id,
    version: v.id,
    fields,
    points: fields.filter((f) => POINT_FIELDS.test(f)),
    boxes: fields.filter((f) => BOX_FIELDS.test(f)),
    text: fields.filter((f) => TEXT_FIELDS.test(f)),
  };
}

/**
 * Replicate's search endpoint uses the HTTP QUERY method with a plain-text
 * body. Not every client or proxy supports that verb, so failure here is
 * expected and non-fatal -- the named candidates above are the fallback.
 */
async function search(term) {
  try {
    const res = await fetch('https://api.replicate.com/v1/models', {
      method: 'QUERY',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: term,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((m) => `${m.owner}/${m.name}`);
  } catch {
    return [];
  }
}

console.log('Searching Replicate for promptable segmentation models…\n');

const found = [...new Set([
  ...await search('segment anything point prompt'),
  ...await search('sam 3 image segmentation'),
  ...await search('grass lawn segmentation aerial'),
])];
if (found.length) {
  console.log(`search returned ${found.length}: ${found.slice(0, 20).join(', ')}\n`);
} else {
  console.log('(search endpoint unavailable — checking named candidates)\n');
}

const slugs = [...new Set([...CANDIDATES, ...found])];
const promptable = [];
const textPromptable = [];

for (const slug of slugs) {
  const { model, error } = await getModel(slug);
  if (error) {
    console.log(`  ✗ ${slug.padEnd(38)} ${error}`);
    continue;
  }

  const info = describe(model);
  if (!info.fields) {
    console.log(`  ? ${slug.padEnd(38)} no readable schema`);
    continue;
  }

  const kinds = [
    info.points.length ? `POINTS(${info.points.join(',')})` : null,
    info.boxes.length ? `box(${info.boxes.join(',')})` : null,
    info.text.length ? `text(${info.text.join(',')})` : null,
  ].filter(Boolean);

  console.log(`  ${info.points.length ? '★' : '·'} ${slug.padEnd(38)} ${kinds.join(' ') || 'automatic only'}`);
  console.log(`      inputs: ${info.fields.join(', ')}`);

  if (info.points.length) promptable.push({ slug, ...info });
  // Text prompting may suit this job better than pins: "grass" segments every
  // patch at once, including the disconnected ones, with nothing to tap.
  if (info.text.length && /sam|segment/i.test(slug)) textPromptable.push({ slug, ...info });
}

console.log('\n' + '='.repeat(70));
if (textPromptable.length) {
  console.log(`Text-promptable segmenters (say "grass", get every patch): ${textPromptable.length}`);
  for (const m of textPromptable) {
    console.log(`  ${m.slug}  [${m.text.join(', ')}]`);
    console.log(`    version: ${m.version}`);
    console.log(`    inputs:  ${m.fields.join(', ')}`);
  }
  console.log('');
}

if (!promptable.length) {
  console.log('No promptable model found among the candidates.');
  console.log('\nFallback that needs no prompting: keep meta/sam-2 in automatic mode,');
  console.log('let it segment everything, and pick the masks containing each pin.');
  process.exit(0);
}

console.log(`Promptable models found: ${promptable.length}\n`);
for (const m of promptable) {
  console.log(`  ${m.slug}`);
  console.log(`    version: ${m.version}`);
  console.log(`    point fields: ${m.points.join(', ')}`);
  console.log(`    all inputs:   ${m.fields.join(', ')}\n`);
}
console.log('Set SAM_MODEL and SAM_INPUT_FIELDS in worker/src/index.js to match one.');

/*
 * The exact contract for whichever models were asked about.
 *
 * Everything above is a shortlist. This is what you build against: each input's
 * type, default, and the model's own description of it, plus the output shape.
 * Getting the point format wrong is a failed prediction that costs money to
 * find out about, and the schema says it for free.
 *
 *   DETAIL='ocg2347/sam-pointprompt,casia-iva-lab/fastsam' node tools/find-sam-model.js
 */
for (const slug of DETAIL) {
  console.log('\n' + '='.repeat(70));
  console.log(`FULL SCHEMA: ${slug}`);
  const { model, error } = await getModel(slug);
  if (error) { console.log(`  unreachable: ${error}`); continue; }

  const v = model.latest_version;
  console.log(`  ${(model.description || '').slice(0, 200).replace(/\s+/g, ' ')}`);
  console.log(`  runs: ${model.run_count?.toLocaleString() ?? '?'}   version: ${v?.id?.slice(0, 12)}…`);

  const schemas = v?.openapi_schema?.components?.schemas;
  const props = schemas?.Input?.properties || {};
  const required = schemas?.Input?.required || [];
  console.log('  inputs:');
  for (const [name, spec] of Object.entries(props)) {
    const type = spec.type || (spec.allOf ? 'enum/ref' : '?');
    const items = spec.items ? ` of ${spec.items.type || JSON.stringify(spec.items)}` : '';
    console.log(`    ${name}${required.includes(name) ? ' (required)' : ''}: ${type}${items}` +
      (spec.default !== undefined ? `  default=${JSON.stringify(spec.default)}` : ''));
    if (spec.description) console.log(`        ${spec.description.slice(0, 220).replace(/\s+/g, ' ')}`);
  }
  console.log(`  output: ${JSON.stringify(schemas?.Output) || '(not published)'}`);
}
