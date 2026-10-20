# Sprinkler catalogue: the schema (water session)

One JSON file per research group in this folder, each:

```json
{
  "group": "rainbird-sprays",
  "retrieved": "2026-10-20",
  "bodies": [
    {
      "id": "rb-1804-prs",               // brand-model, lowercase, dashes
      "brand": "Rain Bird",
      "model": "1804 PRS",                // as sold
      "kind": "spray",                    // spray | rotor | rotary-body | impact | bubbler
      "popUpIn": 4,                       // pop-up height, inches (null if not a pop-up)
      "regulatedPsi": 30,                 // pressure-regulated stem/body: the outlet psi; null if not regulated
      "swappable": true,                  // takes interchangeable nozzles
      "nozzleFamilies": ["rb-mpr", "rb-van", "rb-he-van", "rb-r-van"],   // ids of families it takes
      "fixedNozzles": null,               // a body with built-in, non-swappable nozzle(s): a family id
      "source": "https://..."             // the page or PDF the body facts came from
    }
  ],
  "families": [
    {
      "id": "rb-mpr",
      "brand": "Rain Bird",
      "name": "MPR spray nozzles",
      "kind": "spray",                    // spray | rotary (multi-stream: MP Rotator, R-VAN) | rotor | impact | bubbler
      "flow": "arc",                      // "arc": gpm scales with the arc (rows give gpm for a FULL 360 circle);
                                          // "constant": the nozzle's gpm whatever the arc (rotor nozzles)
      "nozzles": [
        {
          "id": "rb-mpr-15q",
          "label": "15Q",                 // as printed on the nozzle / in the chart
          "arcFixed": 90,                 // fixed pattern: its arc in degrees; null if adjustable
          "arcMin": null, "arcMax": null, // adjustable: the range in degrees
          "strip": null,                  // strip nozzles: { "widthFt": 4, "lengthFt": 15, "type": "end|side|center" }, else null
          "trajectoryDeg": 30,            // if the chart gives it, else null
          "rows": [                       // one row per pressure the chart lists, AS PRINTED
            { "psi": 30, "radiusFt": 15, "gpm": 3.70 }   // gpm for a full 360 circle if flow = "arc"
          ],
          "chartPrecip": { "square": 1.58, "triangle": 1.83 }  // in/h as the chart prints it, at the chart's reference psi, else null
        }
      ],
      "source": "https://..."             // the chart (PDF or page) the numbers came from
    }
  ],
  "notes": ["anything not found, or read with doubt"]
}
```

Rules
- Numbers are transcribed from the manufacturer's own performance chart, never invented or
  interpolated. A value the chart does not give is null. Name the source for each family.
- For a fixed-arc spray nozzle (e.g. 15Q at 0.92 gpm) store the FULL-CIRCLE equivalent
  (0.92 x 4 = 3.70) and arcFixed 90, so every spray nozzle reads the same way; say so in notes if
  a chart's flows are clearly not proportional to the arc.
- Rotor nozzles: flow "constant", gpm as printed, arcMin/arcMax the rotor's adjustment.
- Keep ids stable and unique across the whole catalogue (prefix with the brand: rb-, hu-, to-, kr-, or-).
