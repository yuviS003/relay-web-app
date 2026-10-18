/*
 * Turns a composed request into runnable code.
 *
 * The only genuinely tricky part is quoting, and it is trickier than it looks
 * because every target escapes differently. A URL or header value is
 * user-controlled text, and a generator that concatenates it into a shell
 * command produces a snippet that executes whatever the user pasted the moment
 * they run it: `'; rm -rf ~; '` in a header value is the whole attack, and it
 * works because the victim is the user themselves.
 *
 * So every target gets the quoting its own language needs, and nothing is
 * interpolated raw:
 *
 *   POSIX shell   single quotes, with the classic '\'' dance
 *   PowerShell    single quotes, doubling an embedded quote
 *   PHP, Ruby     single quotes, escaping the quote and the backslash
 *   Kotlin, Dart  double quotes, plus an escaped $ so nothing interpolates
 *   the rest      JSON string literals, which are valid in all of them
 *
 * Values arrive already substituted: what the snippet contains is the real URL
 * and the real body, not {{placeholders}} that mean nothing outside this app.
 */

export type CodeTarget =
  | 'curl'
  | 'wget'
  | 'httpie'
  | 'powershell'
  | 'fetch'
  | 'axios'
  | 'python'
  | 'httpx'
  | 'go'
  | 'java'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'rust'
  | 'swift'
  | 'kotlin'
  | 'dart';

export type CodegenRequest = {
  method: string;
  url: string;
  headers: readonly { name: string; value: string; enabled: boolean }[];
  body: string;
};

export const CODE_TARGETS: readonly {
  id: CodeTarget;
  label: string;
  group: string;
}[] = [
  { id: 'curl', label: 'cURL', group: 'Command line' },
  { id: 'wget', label: 'wget', group: 'Command line' },
  { id: 'httpie', label: 'HTTPie', group: 'Command line' },
  { id: 'powershell', label: 'PowerShell', group: 'Command line' },
  { id: 'fetch', label: 'JavaScript fetch', group: 'JavaScript' },
  { id: 'axios', label: 'JavaScript axios', group: 'JavaScript' },
  { id: 'python', label: 'Python requests', group: 'Python' },
  { id: 'httpx', label: 'Python httpx', group: 'Python' },
  { id: 'go', label: 'Go net/http', group: 'Compiled' },
  { id: 'java', label: 'Java HttpClient', group: 'Compiled' },
  { id: 'csharp', label: 'C# HttpClient', group: 'Compiled' },
  { id: 'rust', label: 'Rust reqwest', group: 'Compiled' },
  { id: 'swift', label: 'Swift URLSession', group: 'Compiled' },
  { id: 'kotlin', label: 'Kotlin OkHttp', group: 'Compiled' },
  { id: 'php', label: 'PHP cURL', group: 'Scripting' },
  { id: 'ruby', label: 'Ruby Net::HTTP', group: 'Scripting' },
  { id: 'dart', label: 'Dart http', group: 'Scripting' },
];

/**
 * Wraps a value in single quotes for POSIX shells. Inside single quotes every
 * character is literal except the quote itself, which is closed, escaped, and
 * reopened: the classic `'\''` dance.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** PowerShell single quotes: an embedded quote is doubled. */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** PHP and Ruby single quotes: backslash first, then the quote. */
function sqQuote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** A JSON string literal, which is also a valid literal in most languages. */
function str(value: string): string {
  return JSON.stringify(value);
}

/**
 * For languages where `$` interpolates inside a double-quoted string. Escaping
 * it means a body containing `$name` stays a literal instead of becoming a
 * reference to a variable that does not exist — or, worse, one that does.
 */
function noInterp(value: string): string {
  return str(value).replaceAll('$', '\\$');
}

function activeHeaders(
  request: CodegenRequest,
): readonly { name: string; value: string }[] {
  return request.headers
    .filter((pair) => pair.enabled && pair.name.trim() !== '')
    .map((pair) => ({ name: pair.name.trim(), value: pair.value }));
}

function hasBody(request: CodegenRequest): boolean {
  const method = request.method.toUpperCase();
  return request.body.trim() !== '' && method !== 'GET' && method !== 'HEAD';
}

function toCurl(request: CodegenRequest): string {
  const lines = [`curl -X ${request.method.toUpperCase()} ${shellQuote(request.url)}`];

  for (const header of activeHeaders(request)) {
    lines.push(`  -H ${shellQuote(`${header.name}: ${header.value}`)}`);
  }

  if (hasBody(request)) {
    // --data-raw, not --data: plain --data strips newlines and mangles a
    // formatted JSON payload.
    lines.push(`  --data-raw ${shellQuote(request.body)}`);
  }

  return lines.join(' \\\n');
}

function toWget(request: CodegenRequest): string {
  const lines = [
    `wget --method=${request.method.toUpperCase()}`,
    '  -q -S -O -',
  ];
  for (const header of activeHeaders(request)) {
    lines.push(`  --header=${shellQuote(`${header.name}: ${header.value}`)}`);
  }
  if (hasBody(request)) lines.push(`  --body-data=${shellQuote(request.body)}`);
  lines.push(`  ${shellQuote(request.url)}`);
  return lines.join(' \\\n');
}

function toHttpie(request: CodegenRequest): string {
  const parts = ['http', request.method.toUpperCase(), shellQuote(request.url)];
  for (const header of activeHeaders(request)) {
    parts.push(shellQuote(`${header.name}:${header.value}`));
  }

  const command = parts.join(' ');
  if (!hasBody(request)) return command;

  // HTTPie reads a raw body from stdin, which avoids re-quoting JSON.
  return `echo ${shellQuote(request.body)} | ${command}`;
}

function toPowerShell(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines: string[] = [];

  if (headers.length > 0) {
    lines.push('$headers = @{');
    for (const header of headers) {
      lines.push(`  ${psQuote(header.name)} = ${psQuote(header.value)}`);
    }
    lines.push('}');
    lines.push('');
  }
  if (hasBody(request)) {
    lines.push(`$body = ${psQuote(request.body)}`);
    lines.push('');
  }

  const args = [
    `-Uri ${psQuote(request.url)}`,
    `-Method ${request.method.toUpperCase()}`,
  ];
  if (headers.length > 0) args.push('-Headers $headers');
  if (hasBody(request)) args.push('-Body $body');

  lines.push(`Invoke-RestMethod ${args.join(' ')}`);
  return lines.join('\n');
}

function toFetch(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = [`const response = await fetch(${str(request.url)}, {`];
  lines.push(`  method: ${str(request.method.toUpperCase())},`);

  if (headers.length > 0) {
    lines.push('  headers: {');
    for (const header of headers) {
      lines.push(`    ${str(header.name)}: ${str(header.value)},`);
    }
    lines.push('  },');
  }

  if (hasBody(request)) {
    // A JSON string literal of the body keeps newlines and quotes intact.
    lines.push(`  body: ${str(request.body)},`);
  }

  lines.push('});');
  lines.push('');
  lines.push('console.log(response.status);');
  lines.push('console.log(await response.text());');
  return lines.join('\n');
}

function toAxios(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = ["import axios from 'axios';", '', 'const response = await axios({'];
  lines.push(`  method: ${str(request.method.toLowerCase())},`);
  lines.push(`  url: ${str(request.url)},`);
  if (headers.length > 0) {
    lines.push('  headers: {');
    for (const header of headers) {
      lines.push(`    ${str(header.name)}: ${str(header.value)},`);
    }
    lines.push('  },');
  }
  if (hasBody(request)) {
    // Sent as a string, so axios does not re-serialise a body that is already
    // exactly what should go out.
    lines.push(`  data: ${str(request.body)},`);
  }
  // Without this axios throws on any 4xx, which hides the response being
  // inspected.
  lines.push('  validateStatus: () => true,');
  lines.push('});');
  lines.push('');
  lines.push('console.log(response.status);');
  lines.push('console.log(response.data);');
  return lines.join('\n');
}

function toPython(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = ['import requests', ''];

  if (headers.length > 0) {
    lines.push('headers = {');
    for (const header of headers) {
      lines.push(`    ${str(header.name)}: ${str(header.value)},`);
    }
    lines.push('}');
    lines.push('');
  }

  if (hasBody(request)) {
    lines.push(`data = ${str(request.body)}`);
    lines.push('');
  }

  const args = [str(request.url)];
  if (headers.length > 0) args.push('headers=headers');
  if (hasBody(request)) args.push('data=data');

  lines.push(
    `response = requests.${request.method.toLowerCase()}(${args.join(', ')})`,
  );
  lines.push('print(response.status_code)');
  lines.push('print(response.text)');
  return lines.join('\n');
}

function toHttpx(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = ['import httpx', ''];
  const args = [str(request.method.toUpperCase()), str(request.url)];

  if (headers.length > 0) {
    lines.push('headers = {');
    for (const header of headers) {
      lines.push(`    ${str(header.name)}: ${str(header.value)},`);
    }
    lines.push('}');
    lines.push('');
    args.push('headers=headers');
  }
  if (hasBody(request)) {
    lines.push(`content = ${str(request.body)}`);
    lines.push('');
    args.push('content=content');
  }

  lines.push('with httpx.Client() as client:');
  lines.push(`    response = client.request(${args.join(', ')})`);
  lines.push('');
  lines.push('print(response.status_code)');
  lines.push('print(response.text)');
  return lines.join('\n');
}

function toGo(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
  ];
  if (hasBody(request)) lines.push('\t"strings"');
  lines.push(')', '', 'func main() {');

  if (hasBody(request)) {
    lines.push(`\tbody := strings.NewReader(${str(request.body)})`);
    lines.push(
      `\treq, err := http.NewRequest(${str(request.method.toUpperCase())}, ${str(
        request.url,
      )}, body)`,
    );
  } else {
    lines.push(
      `\treq, err := http.NewRequest(${str(request.method.toUpperCase())}, ${str(
        request.url,
      )}, nil)`,
    );
  }
  lines.push('\tif err != nil {', '\t\tpanic(err)', '\t}');

  for (const header of headers) {
    lines.push(`\treq.Header.Set(${str(header.name)}, ${str(header.value)})`);
  }

  lines.push(
    '',
    '\tresp, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer resp.Body.Close()',
    '',
    '\tout, _ := io.ReadAll(resp.Body)',
    '\tfmt.Println(resp.StatusCode)',
    '\tfmt.Println(string(out))',
    '}',
  );
  return lines.join('\n');
}

function toJava(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = [
    'import java.net.URI;',
    'import java.net.http.HttpClient;',
    'import java.net.http.HttpRequest;',
    'import java.net.http.HttpResponse;',
    '',
    'HttpClient client = HttpClient.newHttpClient();',
    '',
    'HttpRequest request = HttpRequest.newBuilder()',
    `    .uri(URI.create(${str(request.url)}))`,
  ];

  for (const header of headers) {
    lines.push(`    .header(${str(header.name)}, ${str(header.value)})`);
  }

  lines.push(
    hasBody(request)
      ? `    .method(${str(request.method.toUpperCase())}, HttpRequest.BodyPublishers.ofString(${str(
          request.body,
        )}))`
      : `    .method(${str(request.method.toUpperCase())}, HttpRequest.BodyPublishers.noBody())`,
  );
  lines.push('    .build();');
  lines.push('');
  lines.push(
    'HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());',
  );
  lines.push('System.out.println(response.statusCode());');
  lines.push('System.out.println(response.body());');
  return lines.join('\n');
}

function toCSharp(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = [
    'using System;',
    'using System.Net.Http;',
    'using System.Text;',
    '',
    'using var client = new HttpClient();',
    '',
    `var request = new HttpRequestMessage(new HttpMethod(${str(
      request.method.toUpperCase(),
    )}), ${str(request.url)});`,
  ];

  const contentType = headers.find(
    (header) => header.name.toLowerCase() === 'content-type',
  );
  for (const header of headers) {
    // Content headers live on the body in HttpClient, and adding one to the
    // request throws InvalidOperationException instead of being ignored.
    if (header.name.toLowerCase() === 'content-type') continue;
    lines.push(`request.Headers.TryAddWithoutValidation(${str(header.name)}, ${str(header.value)});`);
  }

  if (hasBody(request)) {
    lines.push(
      `request.Content = new StringContent(${str(request.body)}, Encoding.UTF8, ${str(
        contentType?.value.split(';')[0]?.trim() ?? 'text/plain',
      )});`,
    );
  }

  lines.push(
    '',
    'var response = await client.SendAsync(request);',
    'Console.WriteLine((int)response.StatusCode);',
    'Console.WriteLine(await response.Content.ReadAsStringAsync());',
  );
  return lines.join('\n');
}

function toPhp(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = ['<?php', '', '$curl = curl_init();', '', 'curl_setopt_array($curl, ['];
  lines.push(`    CURLOPT_URL => ${sqQuote(request.url)},`);
  lines.push('    CURLOPT_RETURNTRANSFER => true,');
  lines.push(`    CURLOPT_CUSTOMREQUEST => ${sqQuote(request.method.toUpperCase())},`);

  if (headers.length > 0) {
    lines.push('    CURLOPT_HTTPHEADER => [');
    for (const header of headers) {
      lines.push(`        ${sqQuote(`${header.name}: ${header.value}`)},`);
    }
    lines.push('    ],');
  }
  if (hasBody(request)) {
    lines.push(`    CURLOPT_POSTFIELDS => ${sqQuote(request.body)},`);
  }

  lines.push(']);', '', '$response = curl_exec($curl);');
  lines.push('echo curl_getinfo($curl, CURLINFO_HTTP_CODE) . PHP_EOL;');
  lines.push('curl_close($curl);', 'echo $response . PHP_EOL;');
  return lines.join('\n');
}

function toRuby(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const method = request.method.toUpperCase();
  const lines = [
    "require 'net/http'",
    "require 'uri'",
    '',
    `uri = URI(${sqQuote(request.url)})`,
    `request = Net::HTTPGenericRequest.new(${sqQuote(method)}, ${
      hasBody(request) ? 'true' : 'false'
    }, true, uri)`,
  ];

  for (const header of headers) {
    lines.push(`request[${sqQuote(header.name)}] = ${sqQuote(header.value)}`);
  }
  if (hasBody(request)) lines.push(`request.body = ${sqQuote(request.body)}`);

  lines.push(
    '',
    "response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') do |http|",
    '  http.request(request)',
    'end',
    '',
    'puts response.code',
    'puts response.body',
  );
  return lines.join('\n');
}

function toRust(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = [
    '// Cargo.toml: reqwest = { version = "0.12", features = ["blocking"] }',
    '',
    'fn main() -> Result<(), Box<dyn std::error::Error>> {',
    '    let client = reqwest::blocking::Client::new();',
    `    let response = client`,
    `        .request(${str(request.method.toUpperCase())}.parse()?, ${str(request.url)})`,
  ];
  for (const header of headers) {
    lines.push(`        .header(${str(header.name)}, ${str(header.value)})`);
  }
  if (hasBody(request)) lines.push(`        .body(${str(request.body)})`);
  lines.push(
    '        .send()?;',
    '',
    '    println!("{}", response.status());',
    '    println!("{}", response.text()?);',
    '    Ok(())',
    '}',
  );
  return lines.join('\n');
}

function toSwift(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = [
    'import Foundation',
    '',
    `var request = URLRequest(url: URL(string: ${str(request.url)})!)`,
    `request.httpMethod = ${str(request.method.toUpperCase())}`,
  ];
  for (const header of headers) {
    lines.push(
      `request.setValue(${str(header.value)}, forHTTPHeaderField: ${str(header.name)})`,
    );
  }
  if (hasBody(request)) {
    lines.push(`request.httpBody = ${str(request.body)}.data(using: .utf8)`);
  }
  lines.push(
    '',
    'let (data, response) = try await URLSession.shared.data(for: request)',
    'print((response as! HTTPURLResponse).statusCode)',
    'print(String(data: data, encoding: .utf8) ?? "")',
  );
  return lines.join('\n');
}

function toKotlin(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = [
    'import okhttp3.*',
    '',
    'val client = OkHttpClient()',
    '',
  ];
  if (hasBody(request)) {
    lines.push(
      `val body = RequestBody.create(${noInterp(request.body)}, null)`,
      '',
    );
  }
  lines.push('val request = Request.Builder()');
  lines.push(`    .url(${noInterp(request.url)})`);
  lines.push(
    `    .method(${noInterp(request.method.toUpperCase())}, ${
      hasBody(request) ? 'body' : 'null'
    })`,
  );
  for (const header of headers) {
    lines.push(`    .header(${noInterp(header.name)}, ${noInterp(header.value)})`);
  }
  lines.push('    .build()', '');
  lines.push('client.newCall(request).execute().use { response ->');
  lines.push('    println(response.code)');
  lines.push('    println(response.body?.string())');
  lines.push('}');
  return lines.join('\n');
}

function toDart(request: CodegenRequest): string {
  const headers = activeHeaders(request);
  const lines = [
    "import 'package:http/http.dart' as http;",
    '',
    'Future<void> main() async {',
    `  final request = http.Request(${noInterp(request.method.toUpperCase())}, Uri.parse(${noInterp(
      request.url,
    )}));`,
  ];
  if (headers.length > 0) {
    lines.push('  request.headers.addAll({');
    for (const header of headers) {
      lines.push(`    ${noInterp(header.name)}: ${noInterp(header.value)},`);
    }
    lines.push('  });');
  }
  if (hasBody(request)) lines.push(`  request.body = ${noInterp(request.body)};`);
  lines.push(
    '',
    '  final streamed = await request.send();',
    '  final response = await http.Response.fromStream(streamed);',
    '  print(response.statusCode);',
    '  print(response.body);',
    '}',
  );
  return lines.join('\n');
}

export function generateCode(
  target: CodeTarget,
  request: CodegenRequest,
): string {
  switch (target) {
    case 'curl':
      return toCurl(request);
    case 'wget':
      return toWget(request);
    case 'httpie':
      return toHttpie(request);
    case 'powershell':
      return toPowerShell(request);
    case 'fetch':
      return toFetch(request);
    case 'axios':
      return toAxios(request);
    case 'python':
      return toPython(request);
    case 'httpx':
      return toHttpx(request);
    case 'go':
      return toGo(request);
    case 'java':
      return toJava(request);
    case 'csharp':
      return toCSharp(request);
    case 'php':
      return toPhp(request);
    case 'ruby':
      return toRuby(request);
    case 'rust':
      return toRust(request);
    case 'swift':
      return toSwift(request);
    case 'kotlin':
      return toKotlin(request);
    case 'dart':
      return toDart(request);
  }
}
