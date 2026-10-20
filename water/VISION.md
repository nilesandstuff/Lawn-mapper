# The owner's vision for the water tool (verbatim)

Written by the owner on 2026-10-18, with the instruction "This is the most
clearly I've spelled out my vision for the tool, so remember this
verbatim." Kept here word for word; nothing below the rule is the owner's.

---

Just to refocus here, i want this tool to be really powerful... It will take the slope, soil drainage classes (assume native soil, maybe we'll add an option to place a 4 inch layer of loamy topsoil on top of lawns if the user says that applies to their lawn), rain, and evapotranspiration rates (adjusted for grass coefficients, use .8 for now, but I've got more specific numbers I can give you later)...

Then from there, the purpose of the tool is for users to see how much AND how often a user needs to water certain areas of their lawn in order to avoid over watering and under watering.

This is the most clearly I've spelled out my vision for the tool, so remember this verbatim.

You have free reign to get started on this and take it as far as you can. Ask for clarifications and high level design choices.

Things to think about:
- known details about the water table if possible, especially in areas below steep hills.
- gutters... We'll have to ask users to enter gutter locations. Gutters will divide the output of rain collected on roofs.
- look into the effects, broadly speaking, of concrete and blacktop in regards to their effect on both runoff and evapotranspiration. This may be a difficult problem to solve because we're going to need to identify them accurately. perhaps by using a vision model... I'm sure there must be some on Replicate.
- simulate french drains and dry wells, with user input via drawing... And suggest them when needed. That will be a distinct step.
- at some point we will incorporate mapping irrigation head placement, including specific brands, models, and the nozzle sizes they use.

---

## Notes kept beside it (water session, not the owner's words)

- Grass coefficient: Kc = 0.8 until the owner gives more specific numbers.
- Soil: the survey's native soil by default; an optional 4 inch (10 cm)
  layer of loamy topsoil over the lawn when the user says it applies.
- The answer the tool exists to give: for each area of the lawn, HOW MUCH
  water and HOW OFTEN, so it is neither over- nor under-watered.
- Later, distinct steps: French drains and dry wells (drawn by the user,
  simulated, suggested when needed); irrigation heads (brand, model,
  nozzle).

## The owner's design choices (2026-10-18, answers to four questions)

- **Paving**: "Whatever is most accurate and fastest." Measure each way of
  finding concrete and blacktop (lidar brightness, the photo, a vision
  model, Replicate's included) against the Chesapeake land use and use the
  best; a paid model is allowed if it measures best (its cost per map said
  to the owner before it is switched on).
- **Gutters**: both downspout taps and gutter lines. For each downspout the
  user taps the spot on the roof edge it empties FROM and the spot on the
  ground it empties TO.
- **Weather**: both a typical-year plan (by month) and a "this week"
  adjustment from recent rain and ET and the forecast.
- **Areas**: the tool draws the zones (soil, slope, sun, run-on); the user
  can redraw them.

## Later choices (owner, 2026-10-20)

- Root depth: "a functional root depth of 8 inches is probably a better starting point than the 12
  inches I gave. There's also species specific numbers and soil texture effects root depth...
  (Compact soil reduces functional root depth)... But we'll dial those in more later."
- "the soak cycle watering regimens that are prescribed should be limited to 2 per day."
- The check: the front yard, full sun, needs about 1 inch a week over 2 or 3 waterings in late June and
  July to keep a good appearance.
