# Dew and the lawn water balance: what is measured, and whether the tool should add a term

Research agent for the water session, 2026-10-28. Tags: [read] = this agent read the text (full text or the
publisher's abstract page); [2nd] = from a citing paper or an abstract snippet. No number is invented; arithmetic
of this agent's own is marked. Monteith 1957, Garratt & Segal 1988, Richards 2004/2005 and Xiao et al. 2009 are
paywalled or bot-walled and are [2nd]; Burrage 1972 ("Dew on wheat") could not be found in any index reached.

## HARD

### 1. How much dew falls on grass

- **Netherlands grassland, 12 years (Jacobs, Heusinkveld, Holtslag & Berkowicz, AMS conference paper c. 2005,
  full text [read]; journal version Jacobs, Heusinkveld & Berkowicz 2006, Water Resources Research 42, W03415
  [2nd]).** Micro-lysimeters on grass at Wageningen verified a surface-energy dew model (Penman with the canopy
  resistance zero while the leaves are wet), run over 1994-2005. Annual dew **37 +/- 8 mm** against 820-830 mm
  rain, "about 4.5%". **250 +/- 25 dew nights a year** (more than 0.05 mm), "nearly 70% of all nights", about 25 a
  month July-September. Monthly dew **3.1 +/- 1.0 mm**, even through the year. Their verdict: "dew is thus of minor
  importance in this region in terms of the total water budget." 37 mm over 250 nights is about **0.15 mm per dew
  night** (this agent's arithmetic). They cite Monteith 1957 for "a theoretical maximum of 0.8 mm per night".
- **Northern Germany, high-precision weighing lysimeters, 2004-05 (Xiao, Meissner, Seeger, Rupp & Borg 2009,
  Journal of Hydrology 377:43-49 [2nd]):** dewfall **27.1-31.8 mm a year**, 5.5-6.9% of rain, over 20% of some
  months' precipitation; grass the continuous-cover reference; a **maximum of 0.5-0.6 mm a night on six nights**
  (as cited by Ritter et al. 2019).
- **US NEON radiometer network, 11 grasslands including KONZ (Kansas) and WOOD/DCFS (North Dakota), 2015-17
  (Ritter, Berkelhammer & Beysens 2019, Hydrol. Earth Syst. Sci. 23:1179-1197 [read]):** dew on 15-95% of
  growing-season nights, rising linearly with night RH above about 75%; 99% of events at wind under 4 m/s, optimum
  about 0.5 m/s; duration 3.4 +/- 1.1 h in temperate grassland; yield **0.14 +/- 0.12 mm per night**; dew "mostly
  forms at the top of grasslands" (29% of nights at the top, 7% inside the canopy). No Great Lakes grassland site;
  no Michigan dew measurement was found anywhere.
- **Vancouver, summer 1996, mini-lysimeters (Richards & Oke 2005, Boundary-Layer Meteorol. 114 [2nd]):** rural
  grass **0.10 mm per night**, urban residential grass **0.07 mm**, a shingle roof 0.12 mm.
- **Semi-arid grassland, weighing lysimeter, a year (Sharma 1976, Agric. Meteorol. [2nd]):** dew 2.5% of rain,
  3.9% of actual ET, negligible in summer.
- **Rates.** Garratt & Segal 1988 (Boundary-Layer Meteorol. 45:209-236 [2nd]): high dewfall rates "usually
  <= 0.06 mm/h" over canopy or bare soil, 0.07-0.09 mm/h only when distillation adds to it under saturated soil
  and air; Monteith measured at most 0.05-0.06 mm/h [2nd]. Eight hours at the ceiling is 0.4-0.5 mm; the typical
  night is a third of that.

**Dewfall, distillation, guttation (Monteith 1957, Q.J.R. Meteorol. Soc. 83:322-341 [2nd], abstract).** A
recording balance on short grass found three regimes: dry grass losing weight; grass wetted by vapour from the
soil condensing on the leaves (distillation, "1-2 mg/cm2/h", i.e. 0.01-0.02 mm/h, "on very calm nights through a
laminar layer"); and net gain from the air (dewfall, turbulent). "On windless nights, since heat flux from the soil
and net radiative loss were almost equal, the transfers of sensible and latent heat from the atmosphere were
negligible and distillation was of much greater importance than dewfall." So on the stillest nights the wet grass
is mostly the soil's own water come up, no gain; dewfall needs a little wind to bring vapour down. Guttation
"amounts are small (Long 1955)" and is neglected (Jacobs et al. [read]).

### 2. Rain gauges and PRISM

NWS Cooperative Observer quick reference (Shreveport office, 2011, full text [read]): "If no precip fell during the
24-hour period, enter 0.00. If the amount was too small to measure ... enter a 'T' for trace. **Condensation from
fog/dew and frost does not count as precip.**" CoCoRaHS logs show the same practice ("dew on gauge", 0.00) [2nd].
PRISM's daily grid is built from these networks (COOP, CoCoRaHS, RAWS, USCRN, SNOTEL; Daly et al. 2021 [2nd]), so
**dew is not in the PRISM rain the tool reads.** Weighing lysimeters, by contrast, do weigh dew as a gain, so turf ET
measured that way (Danielson & Feldhake 1981 in H43) is already net of dew.

### 3. FAO-56 and dew

FAO-56 chapter 3 [read]: for the 24-hour step Rnl uses (Tmax^4 + Tmin^4)/2; "Rn is normally positive during the
daytime and negative during the nighttime"; "the total daily value for Rn is almost always positive over a period of
24 hours". Daily ET0 is one net figure with the night's longwave loss already debited from the day's energy; it never
goes negative and has no dew term. FAO-56 mentions dew only in reading the dew point: "after sunrise, evaporation of
the dew will once again humidify the air". Chapter 4's hourly example gives 0.00 mm/h at 02-03 h [read]; summed
hourly FAO-PM averages 0.95 of the daily value over 40 Australian stations [2nd].

On dew against ET: Jacobs et al.'s model [read] holds dew as a leaf film that evaporates first after sunrise, then
transpiration resumes; dew "is not considered as real precipitation". Moratiel, Spano, Nicolosi & Snyder 2012
(Irrigation Science, "Correcting soil water balance calculations for dew, fog, and light rainfall" [2nd]): "the main
impact of surface vaporization from a wet crop surface is to reduce the contribution of soil water to ETc", so a
balance ignoring it over-estimates depletion. Gerlein-Safdi et al. 2018 (Agric. For. Meteorol. 259:305-316, full
text [read]): dew "can persist for up to 6 h after sunrise (Abtew & Melesse 2012; Monteith 1957)"; 0.5 mm/day of dew
"could satiate about 1/6 of potential transpiration in tropical areas, less in arid climates"; transpiration cut by
up to 25% for 50 cm leaves, less for small ones (grass blades are small). **No measurement of dew dripping from turf
to the soil was found;** every source treats dew on grass as evaporated off the leaves by mid-morning.

### 4. Sky view, canopy and dew

Richards & Oke 2002 (Int. J. Climatol. 22:1915-1933, abstract [read]): dew is heaviest "on clear, calm nights and on
surfaces that cool quickly after sunset, such as grass"; sky view factor modifies it, "the dominant mechanism is
argued to be the systematic increase in longwave radiation loss that is associated with increased sky view", and
dew could be mapped from sky-view maps. Price & Clark 2014 (Boundary-Layer Meteorol., Cardington dewmeters [2nd]):
across one 18 ha field "canopies with a more open aspect experienced more deposition by up to a factor of two".
Already in H47: clear-night surface cooling 6.7 C in open pasture (90% sky) against 0.7 C in closed forest (10% sky),
Feldhake 2009; Stoutjesdijk 1974's cold-sky side of a hedge where "dew persists" and net radiation stays at or below
zero all day. **Under crowns there is less dew; it lasts longer where the morning sun does not reach.**

## SPECULATION (this agent's reasoning)

**Size.** Humid temperate grass gets 27-37 mm of dew a year, 0.1-0.15 mm on a typical dew night, 0.5 mm on the
best. A Michigan May-September at Jacobs' 3.1 mm a month is roughly **12-18 mm a season against about 450 mm of
open-lawn use** (H43's 17.82 in): 3-4%, one or two days of ET. Nearly all of it evaporates off the blades by
mid-morning, so it is not a gain to the soil but a reduction of that morning's draw on it. The energy side agrees:
0.15 mm of condensation releases 0.37 MJ/m2, against a clear July night's longwave loss of 3-5 MJ/m2 (the tool's own
Rnl), so most of the night's loss is paid by soil heat and the air, as Monteith measured, and the 24-hour FAO-56
figure already debits that whole loss from the day; a separate dew term would partly double count it.

**The owner's observation.** The moist shaded soil after a dry spell is not dew: dew is LARGEST in the open (sky
view) and smallest under crowns, the opposite pattern. The shaded cells have less radiation (H45, H47: the shadiest
tenth at 0.24-0.34 of open light), a smaller longwave loss by sky view, less wind (H44, 0.37-0.45 of open) and
cooler, wetter air (H43); the humid spell lowers the air term for every cell through RH in pmParts. Those are in the
balance already and put the shady tenth at about a third of open use. What "smashing dew points" adds beyond that
is leaf wetness lasting into the morning in building shade (Stoutjesdijk), which delays a cell's transpiration by
hours; the model does not resolve it, but it is worth a tenth of a millimetre a night.

**Recommendation: do not add dew as water.** If a term is wanted, the defensible form is a per-cell CAP on the next
day's use, not soil water: dew_i = min(0.15 mm, 8 h x 0.06 mm/h x f_sky(i) x f_RH x f_wind), f_sky the cell's sky
view (the tool has it), f_RH rising from 0 at 75% night RH to 1 near saturation (Ritter), f_wind 1 at 0.5-2 m/s and 0
above 4 m/s; subtract it from the cell's use that day, floored at zero. Over a season that is about 10-15 mm on
open cells and 3-5 mm on the shadiest (sky view 0.24), 2-3% of use: smaller than H44's wind correction, inside
PRISM's day-to-day noise, and partly double-counted against the daily Rnl debit. Better to record the mechanism in
FINDINGS and leave the model alone. What would settle it: blotting-paper or balance dew readings on open lawn against
the lawn north of the house on one clear calm night (the TODO in H47), and a soil probe in both spots that afternoon.
