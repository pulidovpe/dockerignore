'use strict'

// For old node.js versions, we use es5
const fs = require('fs')
const ignore = require('../')
const expect = require('chai').expect
const spawn = require('child_process').spawn
const tmp = require('tmp').dirSync
const mkdirp = require('mkdirp').sync
const path = require('path')
const rm = require('rimraf').sync
const removeEnding = require('pre-suf').removeEnding
const getRawBody = require('raw-body')
const it = require('ava')
const Sema = require('async-sema')
const cuid = require('cuid')

const IS_WINDOWS = process.platform === 'win32'
const SHOULD_TEST_WINDOWS = !process.env.IGNORE_TEST_WIN32
  && IS_WINDOWS
const CI = !!process.env.CI;
const PARALLEL_DOCKER_BUILDS = 6

const cases = [
  [
    'special cases: invalid empty paths, just ignore',
    [
    ],
    {
      '': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    '.git files are just like any other files',
    [
      '.git/*',
      '!.git/config',
      '.ftpconfig'
    ],
    {
      '.ftpconfig': 1,
      '.git/config': 0,
      '.git/description': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    '.dockerignore documentation sample 1',
    [
      '# comment',
      '*/temp*',
      '*/*/temp*',
      'temp?'
    ],
    {
      'somedir/temporary.txt': 1,
      'somedir/temp/something.txt': 1,
      'somedir/subdir/temporary.txt': 1,
      'somedir/subdir/temp/something.txt': 1,
      'tempa/something.txt': 1,
      'tempb/something.txt': 1,
      'something.txt': 0,
      'somedir/something.txt': 0,
      'somedir/subdir/something.txt': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    },
    // true
  ],
  [
    '.dockerignore documentation sample 2',
    [
      '*.md',
      '!README.md'
    ],
    {
      'test.txt': 0,
      'test.md': 1,
      'README.md': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    '.dockerignore documentation sample 3',
    [
      '*.md',
      '!README*.md',
      'README-secret.md'
    ],
    {
      'test.txt': 0,
      'test.md': 1,
      'README.md': 0,
      'README-public.md': 0,
      'README-secret.md': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    '.dockerignore documentation sample 4',
    [
      '*.md',
      'README-secret.md',
      '!README*.md'
    ],
    {
      'test.txt': 0,
      'test.md': 1,
      'README.md': 0,
      'README-public.md': 0,
      'README-secret.md': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'wildcard: special case, escaped wildcard',
    [
      '*.html',
      'a/b/*.html',
      '!a/b/\\*/index.html'
    ],
    {
      'a/b/*/index.html': 0,
      'a/b/index.html': 1,
      'index.html': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'wildcard: treated as a shell glob suitable for consumption by fnmatch(3)',
    [
      '*.html',
      '*/*.html',
      '*/*/*.html',
      '*/*/*/*.html',
      '!b/\*/index.html'
    ],
    {
      'a/b/*/index.html': 1,
      'a/b/index.html': 1,
      'b/*/index.html': 0,
      'b/index.html': 1,
      'index.html': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'wildcard: with no escape',
    [
      '*.html',
      'a/b/*.html',
      '!a/b/*/index.html'
    ],
    {
      'a/b/*/index.html': 0,
      'a/b/index.html': 1,
      'index.html': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'a negative pattern without a trailing wildcard re-includes the directory (unlike gitignore)',
    [
      '/node_modules/*',
      '!/node_modules',
      '!/node_modules/package'
    ],
    {
      'node_modules/a/a.js': 0,
      'node_modules/package/a.js': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'unignore with 1 globstar, reversed order',
    [
      '!foo/bar.js',
      'foo/*'
    ],
    {
      'foo/bar.js': 1,
      'foo/bar2.js': 1,
      'foo/bar/bar.js': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'unignore with 2 globstars, reversed order',
    [
      '!foo/bar.js',
      'foo/**'
    ],
    {
      'foo/bar.js': 1,
      'foo/bar2.js': 1,
      'foo/bar/bar.js': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'unignore with several groups of 2 globstars, reversed order',
    [
      '!foo/bar.js',
      'foo/**/**'
    ],
    {
      'foo/bar': 1,
      'foo/bar.js': 1,
      'foo/bar2.js': 1,
      'foo/bar/bar.js': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'unignore with 1 globstar',
    [
      'foo/*',
      '!foo/bar.js'
    ],
    {
      'foo/bar.js': 0,
      'foo/bar2.js': 1,
      'foo/bar/bar.js': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'unignore with 2 globstars',
    [
      'foo/**',
      '!foo/bar.js'
    ],
    {
      'foo/bar.js': 0,
      'foo/bar2.js': 1,
      'foo/bar/bar.js': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'several groups of 2 globstars',
    [
      'foo/**/**',
      '!foo/bar.js'
    ],
    {
      'foo/bar.js': 0,
      'foo/bar2.js': 1,
      'foo/bar/bar.js': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  // description  patterns  paths/expect  only
  [
    'ignore dot files',
    [
      '.*'
    ],
    {
      '.a': 1,
      '.gitignore': 1,
      'Dockerfile': 0,
      '.dockerignore': 1
    }
  ],

  [
    'Negate directory inside ignored directory',
    [
      '.abc/*',
      '!.abc/d/'
    ],
    {
      '.abc/a.js': 1,
      '.abc/d/e.js': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'wildcard with whitelisting', [
      '*',
      '!package.json',
      '!src',
      '!yarn.lock'
    ], {
      'node_modules/gulp/node_modules/abc.md': 1,
      'node_modules/zeit': 1,
      'package.json': 0,
      'yarn.lock': 0,
      'src/index.js': 0,
      '.git/abc': 1,
      'Dockerfile': 1,
      '.dockerignore': 1,
    }
  ],

  [
    'Negate wildcard inside ignored parent directory (gitignore differs here)',
    [
      '.abc/*',
      // .abc/d will be ignored
      '!.abc/d/*'
    ],
    {
      '.abc/a.js': 1,
      // but '.abc/d/e.js' won't be (unlike gitignore)
      '.abc/d/e.js': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'A blank line matches no files',
    [
      ''
    ],
    {
      'a.txt': 0,
      'a/b/c.txt': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'A line starting with # serves as a comment.',
    ['#abc'],
    {
      '#abc': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'Put a backslash ("\\") in front of the first hash for patterns that begin with a hash.',
    [
      '\\#abc'
    ],
    {
      '#abc': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  // TODO: Fix these tests case
  // These test cases are currently being skipped because we need verify
  // what dockerignore actually does and the "vs. docker" test won't work
  // because listing files using find . on the docker image and getting
  // the list of files trims whitespace.
  // After manually verifying these test cases, we'll bring them back
  // [
  //   'Trailing spaces are ignored unless they are quoted with backslash ("\\")',
  //   [
  //     'abc\\  ', // only one space left -> (abc )
  //     'bcd  ',   // no space left -> (bcd)
  //     'cde \\ '  // two spaces -> (cde  )
  //   ],
  //   {
  //     // nothing to do with backslashes
  //     'abc\\  ': 1,
  //     'abc  ': 0,
  //     'abc ': 0,
  //     'abc   ': 0,
  //     'bcd': 1,
  //     'bcd ': 1,
  //     'bcd  ': 1,
  //     'cde  ': 0,
  //     'cde ': 0,
  //     'cde   ': 0
  //   },
  //   true,
  //   true
  // ],
  // [
  //   'spaces are accepted in patterns. "\\ " doesn\'t mean anything special',
  //   [
  //     'abc d',
  //     'abc\ e',
  //     'abc\\ f',
  //     'abc/a b c'
  //   ],
  //   {
  //     'abc d': 1,
  //     'abc\ e': 1,
  //     'abc/a b c': 1,
  //     'abc\\ f': 0,
  //     'abc': 0,
  //     'abc/abc d': 0,
  //     'abc/abc e': 0,
  //     'abc/abc f': 0
  //   }
  // ],
  // [
  //   'Put a backslash ("\\") in front of the first "!" for patterns that begin with a literal "!"',
  //   [
  //     '\\!abc',
  //     '\\!important!.txt'
  //   ],
  //   {
  //     '!abc': 1,
  //     'abc': 0,
  //     'b/!important!.txt': 0,
  //     '!important!.txt': 1
  //   }
  // ],
  [
    'An optional prefix "!" which negates the pattern; any matching file excluded by a previous pattern will become included again',
    [
      'abc',
      '!abc'
    ],
    {
      'abc/a.js': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'It is possible to re-include a file if a parent directory of that file is excluded',
    [
      'abc/',
      '!abc/a.js'
    ],
    {
      'abc/a.js': 0,
      'abc/d/e.js': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'we did not know whether the rule is a dir first',
    [
      'abc',
      'bcd/abc',
      '!bcd/abc/a.js'
    ],
    {
      'abc/a.js': 1,
      'bcd/abc/f.js': 1,
      'bcd/abc/a.js': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'If the pattern ends with a slash, the slash is basically ignored/dropped',
    [
      'abc/'
    ],
    {
      'abc/def.txt': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'If the pattern does not contain a slash /, it\'s just a file in current directory',
    [
      'a.js',
      'f/'
    ],
    {
      'a.js': 1,
      'b/a/a.js': 0,
      'a/a.js': 0,
      'b/a.jsa': 0,
      'f/h': 1,
      'g/f/h': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'Otherwise, it\'s a complete relative path',
    [
      'a/a.js'
    ],
    {
      'a/a.js': 1,
      'a/a.jsa': 0,
      'b/a/a.js': 0,
      'c/a/a.js': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'wildcards in the pattern will not match a / in the pathname.',
    [
      'Documentation/*.html'
    ],
    {
      'Documentation/git.html': 1,
      'Documentation/dir.html/test.txt': 1,
      'Documentation/ppc/ppc.html': 0,
      'tools/perf/Documentation/perf.html': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'A leading slash matches the beginning of the pathname',
    [
      '/*.c'
    ],
    {
      'cat-file.c': 1,
      'mozilla-sha1/sha1.c': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'A leading "**" followed by a slash means match in all directories',
    [
      '**/foo'
    ],
    {
      'foo/a': 1,
      'a/foo/a': 1,
      'a/b/c/foo/a': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    '"**/foo/bar" matches file "bar" anywhere that is directly under directory "foo"',
    [
      '**/foo/bar'
    ],
    {
      'foo/bar': 1,
      'abc/foo/bar': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    '"**/foo/bar" matches directory "bar" anywhere that is directly under directory "foo"',
    [
      '**/foo/bar'
    ],
    {
      'foo/bar': 1,
      'abc/foo/bar/abc': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'A trailing "/**" matches everything inside',
    [
      'abc/**',
      '*/abc/**',
    ],
    {
      'abc/b': 1,
      'abc/d/e/f/g': 1,
      'bcd/abc/a': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'A slash followed by two consecutive asterisks then a slash matches zero or more directories',
    [
      'a/**/b'
    ],
    {
      'a/b': 1,
      'a/x/a': 0,
      'a/x/b': 1,
      'a/x/y/a': 0,
      'a/x/y/b': 1,
      'b/a.txt': 0,
      'b/a/b': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'add a file content',
    'test/fixtures/.aignore',
    {
      'abc/a.js': 1,
      'abc/b/b.js': 0,
      '#e': 0,
      '#f': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],

  [
    'test a dockerignore file that failed in now-cli',
    'test/fixtures/.now-ignore',
    {
      '.dockerignore': 1,
      '.flowconfig': 1,
      '.gitignore': 1,
      'Dockerfile': 1,
      'now.json': 1,
      'package.json': 0,
      'readme.md': 1,
      'rollup.config.js': 0,
      'yarn.lock': 0,
      '.git/a': 1,
      'src/index.js': 0,
      'src/main.js': 0,
      'src/schemas/index.js': 0,
    }
  ],

  [
    'https://github.com/zeit/now-cli/issues/1368',
    'test/fixtures/.now-ignore-2',
    {
      '.dockerignore': 1,
      '.flowconfig': 1,
      '.gitignore': 1,
      'Dockerfile': 1,
      'now.json': 1,
      'readme.md': 1,
      '.git/a': 1,
      'src/index.js': 0,
      'src/main.js': 0,
      'src/schemas/index.js': 0,
    }
  ],

  [
    'question mark should not break all things',
    'test/fixtures/.ignore-issue-2', {
      '.project': 1,
      // remain
      'abc/.project': 0,
      '.a.sw': 0,
      '.a.sw?': 1,
      'thumbs.db': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'dir ended with "*"', [
      'abc/*'
    ], {
      'abd': 0,
      'abc/def.txt': 1,
      'abc/def/ghi': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'file ended with "*"', [
      'abc*',
    ], {
      'abc': 1,
      'abcdef': 1,
      'abcd/test.txt': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'dir ended with "*"', [
      'abc*',
    ], {
      'abc': 1,
      'abc/def.txt': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'wildcard as filename', [
      '*.b'
    ], {
      '.b': 1,
      'a.b': 1,
      'b/.b': 0,
      'b/a.b': 0,
      'b/.ba': 0,
      'b/c/a.b': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'slash at the beginning and come with a wildcard', [
      '/*.c'
    ], {
      '.c': 1,
      'c.c': 1,
      'c/c.c': 0,
      'c/d': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'dot file', [
      '.d',
      '*/.d',
    ], {
      '.d': 1,
      '.dd': 0,
      'd.d': 0,
      'd/.d': 1,
      'd/d.d': 0,
      'd/e': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'dot dir', [
      '.e',
      '*/.e'
    ], {
      '.ee': 0,
      'e.e': 0,
      '.e/e': 1,
      '.e/f': 1,
      'e/.e': 1,
      'f/.e': 1,
      'e/e.e': 0,
      'e/f': 0,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'node modules: once', [
      'node_modules/'
    ], {
      'node_modules/gulp/node_modules/abc.md': 1,
      'node_modules/gulp/node_modules/abc.json': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ],
  [
    'node modules: twice', [
      'node_modules/',
      'node_modules/'
    ], {
      'node_modules/gulp/node_modules/abc.md': 1,
      'node_modules/gulp/node_modules/abc.json': 1,
      'Dockerfile': 0,
      '.dockerignore': 0
    }
  ]
]

let cases_to_test_only = cases.filter(function (c) {
  return c[3]
})

function readPatterns(file) {
  return fs.readFileSync(file).toString()
}

let real_cases = cases_to_test_only.length
  ? cases_to_test_only
  : cases

real_cases.forEach(function(c) {
  const description = c[0]
  let patterns = c[1]
  const paths_object = c[2]
  const skip_test_test = !CI || c[4]

  if (typeof patterns === 'string') {
    patterns = readPatterns(patterns)
  }

  // All paths to test
  let paths = Object.keys(paths_object)

  // paths that NOT ignored
  let expected = paths
  .filter(function(p) {
    return !paths_object[p]
  })
  .sort()

  function expect_result(t, result, mapper) {
    if (mapper) {
      expected = expected.map(mapper)
    }

    t.deepEqual(result.sort(), expected.sort())
  }

  it('.filter():'.padEnd(26) + description, function(t) {
    t.plan(1)
    let ig = ignore()
    let result = ig
      .addPattern(patterns)
      .filter(paths)

    expect_result(t, result)
  })

  it('.createFilter():'.padEnd(26) + description, function(t) {
    t.plan(1)
    let result = paths.filter(
      ignore()
      .addPattern(patterns)
      .createFilter(),
      // thisArg should be binded
      null
    )

    expect_result(t, result)
  })

  it('.ignores(path):'.padEnd(26) + description, function (t) {
    t.plan(Object.keys(paths_object).length)
    let ig = ignore().addPattern(patterns)

    Object.keys(paths_object).forEach(function (path) {
      t.is(ig.ignores(path), !!paths_object[path])
    })
  })


  // TODO: Is this still applicable with dockerignore
  // Perhaps we should update the test and remov this flag
  // In some platform, the behavior of trailing spaces is weird
  // is not implemented as documented, so skip test
  !skip_test_test
  // Tired to handle test cases for test cases for windows
  && !IS_WINDOWS
  && it('vs. docker:'.padEnd(26) + description, async function (t) {
    t.plan(1)
    let result = (await getNativeDockerIgnoreResults(patterns, paths)).sort()

    expect_result(t, result)
  })

  SHOULD_TEST_WINDOWS && it('win32: .filter():'.padEnd(26) + description, function(t) {
    t.plan(1)
    let win_paths = paths.map(make_win32)

    let ig = ignore()
    let result = ig
      .addPattern(patterns)
      .filter(win_paths)

    expect_result(t, result, make_win32)
  })
})

it('.add(<Ignore>)'.padEnd(26), function(t) {
  t.plan(2)
  let a = ignore().add(['.abc/*', '!.abc/d/'])
  let b = ignore().add(a).add('!.abc/e/')

  let paths = [
    '.abc/a.js',    // filtered out
    '.abc/d/e.js',  // included
    '.abc/e/e.js'   // included by b, filtered out by a
  ]

  t.deepEqual(a.filter(paths), ['.abc/d/e.js'])
  t.deepEqual(b.filter(paths), ['.abc/d/e.js', '.abc/e/e.js'])
})

function make_win32 (path) {
  return path.replace(/\//g, '\\')
}


it('fixes babel class'.padEnd(26), function (t) {
  let constructor = ignore().constructor

  try {
    constructor()
  } catch (e) {
    t.pass()
    return
  }

  t.fail()
})


it('kaelzhang/node-ignore#32'.padEnd(26), function (t) {
  t.plan(2)
  let KEY_IGNORE = typeof Symbol !== 'undefined'
    ? Symbol.for('dockerignore')
    : 'dockerignore';

  let a = ignore().add(['.abc/*', '!.abc/d/'])

  // aa is actually not an IgnoreBase instance
  let aa = {}
  aa._rules = a._rules.slice()
  aa[KEY_IGNORE] = true

  let b = ignore().add(aa).add('!.abc/e/')

  let paths = [
    '.abc/a.js',    // filtered out
    '.abc/d/e.js',  // included
    '.abc/e/e.js'   // included by b, filtered out by a
  ]

  t.deepEqual(a.filter(paths), ['.abc/d/e.js'])
  t.deepEqual(b.filter(paths), ['.abc/d/e.js', '.abc/e/e.js'])
})

it('some tests take longer as docker images are built in the background ', function(t){
  t.pass()
})

let tmpCount = 0
let tmpRoot = tmp().name


function createUniqueTmp () {
  let dir = path.join(tmpRoot, String(tmpCount ++))
  // Make sure the dir not exists,
  // clean up dirty things
  rm(dir)
  mkdirp(dir)
  return dir
}

// number of docker builds in parallel
let dockerBuildSema = new Sema(PARALLEL_DOCKER_BUILDS, {capacity: cases.length})
async function getNativeDockerIgnoreResults (rules, paths) {
  await dockerBuildSema.acquire()
  const dir = createUniqueTmp()
  const imageTag = cuid()

  const dockerignore = typeof rules === 'string'
    ? rules
    : rules.join('\n')

  const DockerfileName = 'Dockerfile'
  const Dockerfile = `
    FROM busybox
    COPY . /build-context
    WORKDIR /build-context
    CMD find . -type f
  `

  paths.forEach(function (path, i) {
    if (path === '.dockerignore') {
      return
    }

    // We do not know if a path is NOT a file,
    // if we:
    // `touch a`
    // and then `touch a/b`, then boooom!
    if (containsInOthers(path, i, paths)) {
      return
    }

    touch(dir, path)
  })

  touch(dir, '.dockerignore', dockerignore)
  touch(dir, DockerfileName, Dockerfile)

  await getRawBody(spawn('docker', ['build', '-f', DockerfileName, '-t', imageTag, '.'], {
    cwd: dir
  }).stdout)

  let runProc = spawn('docker', ['run', '--rm', imageTag], {
    cwd: dir
  })
  
  const out = (await getRawBody(runProc.stdout)).toString('utf8')

  dockerBuildSema.release()

  await getRawBody(spawn('docker', ['rmi', imageTag], {
    cwd: dir
  }).stdout)

  // Remove empty lines and the './' precceding each file
  return out.split('\n').filter(Boolean).map(x => x.slice(2));
}


function touch (root, file, content) {
  // file = specialCharInFileOrDir(file)

  let dirs = file.split('/')
  let basename = dirs.pop()

  let dir = dirs.join('/')

  if (dir) {
    mkdirp(path.join(root, dir))
  }

  // abc/ -> should not create file, but only dir
  if (basename) {
    fs.writeFileSync(path.join(root, file), content || '')
  }
}


function containsInOthers (path, index, paths) {
  path = removeEnding(path, '/')

  return paths.some(function (p, i) {
    if (index === i) {
      return
    }

    return p === path
    || p.indexOf(path) === 0 && p[path.length] === '/'
  })
}
