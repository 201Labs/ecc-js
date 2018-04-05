
/**
 * Module dependencies.
 */

import Parser from './parser';
import Promise from 'bluebird';
import Requester from './requester';
import _ from 'lodash';
import debugnyan from 'debugnyan';
import methods from './methods';
import requestLogger from './logging/request-logger';
import semver from 'semver';

/**
 * Source arguments to find out if a callback has been passed.
 */

function source(...args) {
  const last = _.last(args);

  let callback;

  if (_.isFunction(last)) {
    callback = last;
    args = _.dropRight(args);
  }

  return [args, callback];
}

/**
 * List of networks and their default port mapping.
 */

const networks = {
  mainnet: 19119,
  regtest: 30001,
  testnet: 30001
};

/**
 * Constructor.
 */

class Client {
  constructor({
    agentOptions,
    headers = false,
    host = 'localhost',
    logger = debugnyan('ecc-js'),
    network = 'mainnet',
    password,
    port,
    ssl = false,
    timeout = 30000,
    username,
    version
  } = {}) {
    if (!_.has(networks, network)) {
      throw new Error(`Invalid network name "${network}"`, { network });
    }

    this.agentOptions = agentOptions;
    this.auth = (password || username) && { pass: password, user: username };
    this.hasNamedParametersSupport = false;
    this.headers = headers;
    this.host = host;
    this.password = password;
    this.port = port || networks[network];
    this.timeout = timeout;
    this.ssl = {
      enabled: _.get(ssl, 'enabled', ssl),
      strict: _.get(ssl, 'strict', _.get(ssl, 'enabled', ssl))
    };

    // Find unsupported methods according to version.
    let unsupported = [];

    if (version) {
      // Capture X.Y.Z when X.Y.Z.A is passed to support oddly formatted ecc-js
      // versions such as 0.15.0.1.
      const result = /[0-9]+\.[0-9]+\.[0-9]+/.exec(version);

      if (!result) {
        throw new Error(`Invalid Version "${version}"`, { version });
      }

      [version] = result;

      this.hasNamedParametersSupport = semver.satisfies(version, '>=0.14.0');
      unsupported = _.chain(methods)
        .pickBy(method => !semver.satisfies(version, method.version))
        .keys()
        .invokeMap(String.prototype.toLowerCase)
        .value();
    }

    const request = requestLogger(logger);

    this.request = Promise.promisifyAll(request.defaults({
      agentOptions: this.agentOptions,
      baseUrl: `${this.ssl.enabled ? 'https' : 'http'}://${this.host}:${this.port}`,
      strictSSL: this.ssl.strict,
      timeout: this.timeout
    }), { multiArgs: true });
    this.requester = new Requester({ unsupported, version });
    this.parser = new Parser({ headers: this.headers });
  }

  /**
   * Execute `rpc` command.
   */

  command(...args) {
    let body;
    let callback;
    let parameters = _.tail(args);
    const input = _.head(args);
    const lastArg = _.last(args);

    if (_.isFunction(lastArg)) {
      callback = lastArg;
      parameters = _.dropRight(parameters);
    }

    if (this.hasNamedParametersSupport && parameters.length === 1 && _.isPlainObject(parameters[0])) {
      parameters = parameters[0];
    }

    return Promise.try(() => {
      if (Array.isArray(input)) {
        body = input.map((method, index) => this.requester.prepare({ method: method.method, parameters: method.parameters, suffix: index }));
      } else {
        body = this.requester.prepare({ method: input, parameters });
      }

      return this.request.postAsync({
        auth: _.pickBy(this.auth, _.identity),
        body: JSON.stringify(body),
        uri: '/'
      }).bind(this)
        .then(this.parser.rpc);
    }).asCallback(callback);
  }

  /**
   * Given a transaction hash, returns a transaction in binary, hex-encoded binary, or JSON formats.
   */

  getTransactionByHash(...args) {
    const [[hash, { extension = 'json' } = {}], callback] = source(...args);

    return Promise.try(() => {
      return this.request.getAsync({
        encoding: extension === 'bin' ? null : undefined,
        url: `/rest/tx/${hash}.${extension}`
      }).bind(this)
        .then(_.partial(this.parser.rest, extension));
    }).asCallback(callback);
  }

  /**
   * Given a block hash, returns a block, in binary, hex-encoded binary or JSON formats.
   * With `summary` set to `false`, the JSON response will only contain the transaction
   * hash instead of the complete transaction details. The option only affects the JSON response.
   */

  getBlockByHash(...args) {
    const [[hash, { summary = false, extension = 'json' } = {}], callback] = source(...args);

    return Promise.try(() => {
      return this.request.getAsync({
        encoding: extension === 'bin' ? null : undefined,
        url: `/rest/block${summary ? '/notxdetails/' : '/'}${hash}.${extension}`
      }).bind(this)
        .then(_.partial(this.parser.rest, extension));
    }).asCallback(callback);
  }

  /**
   * Given a block hash, returns amount of blockheaders in upward direction.
   */

  getBlockHeadersByHash(...args) {
    const [[hash, count, { extension = 'json' } = {}], callback] = source(...args);

    return Promise.try(() => {
      if (!_.includes(['bin', 'hex'], extension)) {
        throw new Error(`Extension "${extension}" is not supported`);
      }

      return this.request.getAsync({
        encoding: extension === 'bin' ? null : undefined,
        url: `/rest/headers/${count}/${hash}.${extension}`
      }).bind(this)
        .then(_.partial(this.parser.rest, extension));
    }).asCallback(callback);
  }

  /**
   * Returns various state info regarding block chain processing.
   * Only supports JSON as output format.
   */

  getBlockchainInformation(...args) {
    const [, callback] = source(...args);

    return this.request.getAsync(`/rest/chaininfo.json`)
      .bind(this)
      .then(_.partial(this.parser.rest, 'json'))
      .asCallback(callback);
  }

  /**
   * Query unspent transaction outputs for a given set of outpoints.
   * See BIP64 for input and output serialisation:
   * 	 - https://github.com/bitcoin/bips/blob/master/bip-0064.mediawiki
   */

  getUnspentTransactionOutputs(...args) {
    const [[outpoints, { extension = 'json' } = {}], callback] = source(...args);

    const sets = _.flatten([outpoints]).map(outpoint => {
      return `${outpoint.id}-${outpoint.index}`;
    }).join('/');

    return this.request.getAsync({
      encoding: extension === 'bin' ? null : undefined,
      url: `/rest/getutxos/checkmempool/${sets}.${extension}`
    }).bind(this)
      .then(_.partial(this.parser.rest, extension))
      .asCallback(callback);
  }

  /**
   * Returns transactions in the transaction memory pool.
   * Only supports JSON as output format.
   */

  getMemoryPoolContent(...args) {
    const [, callback] = source(...args);

    return this.request.getAsync('/rest/mempool/contents.json')
      .bind(this)
      .then(_.partial(this.parser.rest, 'json'))
      .asCallback(callback);
  }

  /**
   * Returns various information about the transaction memory pool.
   * Only supports JSON as output format.
   *
   *   - size: the number of transactions in the transaction memory pool.
   *   - bytes: size of the transaction memory pool in bytes.
   *   - usage: total transaction memory pool memory usage.
   */

  getMemoryPoolInformation(...args) {
    const [, callback] = source(...args);

    return this.request.getAsync('/rest/mempool/info.json')
      .bind(this)
      .then(_.partial(this.parser.rest, 'json'))
      .asCallback(callback);
  }
}

/**
 * Add all known RPC methods.
 */

_.forOwn(methods, (range, method) => {
  Client.prototype[method] = _.partial(Client.prototype.command, method.toLowerCase());
});

/**
 * Export Client class (ESM).
 */

export default Client;

/**
 * Export Client class (CJS) for compatibility with require('ecc-js').
 */

module.exports = Client;
