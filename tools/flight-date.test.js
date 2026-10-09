/**
 * When a photo was flown, as a number (public/lib/flight-date.js).
 *
 *   node tools/flight-date.test.js
 */
import { flightDate, byFlightDate, sameFlight } from '../public/lib/flight-date.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
};

check('a season', flightDate('Summer of 2025') === 2025.5 && flightDate('Spring 2022') === 2022.25 && flightDate('Fall of 2024') === 2024.75);
check('a month', Math.abs(flightDate('flown March 2024') - 2024.208) < 1e-3 && Math.abs(flightDate('04/12/2023') - 2023.292) < 1e-3);
check('a catalogue range ends at its newest frame', Math.abs(flightDate('2018-01-01..2026-08-29') - 2026.625) < 1e-3);
check('several: the latest counts', flightDate('Spring 2023; Spring of 2019') === 2023.25);
check('a bare year is the middle of that year', flightDate('2025') === 2025.5 && flightDate(null, 2024) === 2024.5);
check('a year-only service ties with a summer one', sameFlight({ year: 2025 }, { flown: 'Summer of 2025' }));
check('and a spring one is older than it', byFlightDate({ flown: 'Spring 2025' }, { year: 2025 }) > 0);
check('"most current" with no date is undated, not newest', flightDate('Most Current Statewide Imagery') === null && flightDate(null, null) === null);
check('undated sorts last', [{ title: 'current' }, { year: 2019 }, { flown: 'Summer of 2025' }].sort(byFlightDate).map((s) => s.year || s.flown || s.title).join() === 'Summer of 2025,2019,current');
check('two undated are not the same flight', !sameFlight({}, {}));

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
