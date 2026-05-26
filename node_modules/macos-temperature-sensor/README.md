# macos-temperature-sensor

Mac OS Temperature Sensor library for [node.js][nodejs-url]

  [![NPM Version][npm-image]][npm-url]
  [![NPM Downloads][downloads-image]][downloads-url]
  [![Git Issues][issues-img]][issues-url]
[![MIT license][license-img]][license-url]

## Quick Start

This small library captures CPU temperature on macOS (Apple silicon processors), all values are in degree Celsius. This library is intended to be used server side (not within a browser) and is designed to work on ARM based systems.

This library is a replacement for our old [osx-temperature-sensor][osx-temp-npm-url] package (which was designed to work on intel based machines).

### Installation

```bash
$ npm install macos-temperature-sensor
```

### Using this library with Deno:

Make sure, that your deno.json has set the following:
```
{
  ...
  "nodeModulesDir": "auto",
  ...
}
```

Install the package with

```bash
$ deno install --allow-scripts=npm:macos-temperature-sensor
$ deno add npm:macos-temperature-sensor
```

### Usage

Here a small example how to use this library `index.js`:

```js
const macosTemp = require('macos-temperature-sensor');v

let temperature = macosTemp.temperature();
console.log('CPU temperature:');
console.log(temperature);
```

Then run it with `node index.js`

In Deno it would be `index.ts`:

```js
import macosTemp from 'macos-temperature-sensor';

let temperature = macosTemp.temperature();
console.log('CPU temperature:');
console.log(temperature);
```

Then run it with `deno run -A index.ts`

#### Sample output:

```
{
  cpu: 45.832000732421875,
  soc: 45.34083271026611,
  gpu: 45.42668151855469,
  cpuDieTemps: [
    45.832000732421875, 45.121612548828125,
     45.21040344238281, 45.121612548828125,
    45.121612548828125,  45.21040344238281,
    ...
  ],
  probeGroupsTemps: [
    45.56561279296875,
    45.56561279296875,
    45.476806640625,
    ...
  ],
  gpuDieTemps: [
    40.06523132324219,  34.63139343261719,
    45.02667236328125, 44.929351806640625,
    44.70109558105469,  41.27174377441406,
    ...
  ]
}
```

## News and Changes

### Latest Activity


| Version | Date       | Comment                                                                                             |
| ------- | ---------- | --------------------------------------------------------------------------------------------------- |
| 1.0.4      | 24.12.2025 | fix docs                            |
| 1.0.3      | 22.12.2025 | doc improvements                            |
| 1.0.2      | 21.12.2025 | added TS typings, doc improvements          |
| 1.0.1      | 21.12.2025 | fix lib index reference                     |
| 1.0.0      | 21.12.2025 | initial release                             |

If you have comments, suggestions & reports, please feel free to contact me!

This library is used by one of my other libraries [systeminformation][systeminformation-github-url], also available via [github][systeminformation-github-url] and [npm][systeminformation-npm-url]


## Reference

### Function Reference

| Function        | Comments |
| --------------- | -------- |
| macosTemp.version() | library version (no callback/promise) |
| macosTemp.temperature() | CPU temperature (if sensors is installed) in Celsius |
| - cpu | cpu max temperature |
| - soc | soc avg temperature |
| - gpu | max gpu temperature |
| - cpuDieTemps | array of all cpu die temperature points |
| - probeGroupsTemps | array of all probe groups temperature points |
| - gpuDieTemps | array of all gpu die temperature points |

This library is supposed to only work on macOS, apple silicon processors

## Known Issues

I am happy to discuss any comments and suggestions. Please feel free to contact me if you see any possibility of improvement!

## Comments

If you have ideas or comments, please do not hesitate to contact me.


Happy monitoring!

Sincerely,

Sebastian Hildebrandt, [+innovations](http://www.plus-innovations.com)

## Credits

Written by Sebastian Hildebrandt [sebhildebrandt](https://github.com/sebhildebrandt)

## Copyright Information

Apple and macOS are registered trademarks of Apple Inc., Node.js is a trademark of OpenJS Foundation.
All other trademarks are the property of their respective owners.

## License [![MIT license][license-img]][license-url]

>The [`MIT`][license-url] License (MIT)
>
>Copyright &copy; 2025 Sebastian Hildebrandt, [+innovations](http://www.plus-innovations.com).
>
>Permission is hereby granted, free of charge, to any person obtaining a copy
>of this software and associated documentation files (the "Software"), to deal
>in the Software without restriction, including without limitation the rights
>to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
>copies of the Software, and to permit persons to whom the Software is
>furnished to do so, subject to the following conditions:
>
>The above copyright notice and this permission notice shall be included in
>all copies or substantial portions of the Software.
>
>THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
>IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
>FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
>AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
>LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
>OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
>THE SOFTWARE.
>
>Further details see [LICENSE](LICENSE) file.


[npm-image]: https://img.shields.io/npm/v/macos-temperature-sensor.svg?style=flat-square
[npm-url]: https://npmjs.org/package/macos-temperature-sensor
[downloads-image]: https://img.shields.io/npm/dm/macos-temperature-sensor.svg?style=flat-square
[downloads-url]: https://npmjs.org/package/macos-temperature-sensor

[license-url]: https://github.com/sebhildebrandt/macos-temperature-sensor/blob/master/LICENSE
[license-img]: https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square
[npmjs-license]: https://img.shields.io/npm/l/macos-temperature-sensor.svg?style=flat-square
[changelog-url]: https://github.com/sebhildebrandt/macos-temperature-sensor/blob/master/CHANGELOG.md

[nodejs-url]: https://nodejs.org/en/
[docker-url]: https://www.docker.com/

[issues-img]: https://img.shields.io/github/issues/sebhildebrandt/macos-temperature-sensor.svg?style=flat-square
[issues-url]: https://github.com/sebhildebrandt/macos-temperature-sensor/issues

[systeminformation-npm-url]: https://npmjs.org/package/systeminformation
[systeminformation-github-url]: https://github.com/sebhildebrandt/systeminformation
[osx-temp-npm-url]: https://www.npmjs.com/package/osx-temperature-sensor
