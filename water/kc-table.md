<!-- The owner's per-species crop coefficients, received 2026-10-28 (a .docx; the tables as extracted). lib/roots.js KC carries them; FINDINGS H54. -->
# Turfgrass Crop Coefficients (Kc) --- Irrigation Tool Reference

Source: Kc values currently used in the Irrigation tool on
lawn-answers.com (App Version 1.17.3). Values are unitless crop
coefficients by turf type and condition.

How they are used in the app: Weekly irrigation need (inches) = ET₀ × Kc
× 7 days, where ET₀ is daily reference evapotranspiration from FAO-56
Penman-Monteith (Open-Meteo hourly data, weekly forecast average).
Recent rainfall is subtracted before irrigating.

## Table 1 --- Warm-Season Turf

  -------------------------------------------------------------------------
  **Turf Type**          **Normal (Kc     **Deficit (Kc    **Dormancy (Kc
                         active growth)** deficit)**       dormant)**
  ---------------------- ---------------- ---------------- ----------------
  Bermudagrass           0.65--0.80       0.45--0.65       0.20--0.40

  Zoysiagrass            0.60--0.75       0.40--0.60       0.20--0.35

  St. Augustinegrass     0.70--0.85       0.50--0.70       0.25--0.45

  Centipedegrass         0.55--0.70       0.40--0.55       0.15--0.30
  -------------------------------------------------------------------------

## Table 2 --- Cool-Season Turf

  -------------------------------------------------------------------------
  **Turf Type**          **Normal (Kc     **Deficit (Kc    **Dormancy (Kc
                         active growth)** deficit)**       dormant)**
  ---------------------- ---------------- ---------------- ----------------
  Fine Fescue            0.70--0.80       0.50--0.70       0.25--0.50

  Tall Fescue            0.80--1.00       0.60--0.80       0.50

  Kentucky Bluegrass     0.80--1.00       0.65--0.80       0.50

  Perennial Ryegrass     0.85--0.95       0.65--0.75       0.40--0.50
  -------------------------------------------------------------------------

## Notes

Tall Fescue and Kentucky Bluegrass use a single dormancy Kc (0.50);
every other species uses a range.

Ranges are written low--high, as displayed in the app.
