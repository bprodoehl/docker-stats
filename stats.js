#! /usr/bin/env node

'use strict';

var async = require('async');
var nes = require('never-ending-stream');
var through = require('through2');
var split = require('split2');
var pump = require('pump');
var allContainers = require('docker-allcontainers');

function stats(opts) {
  opts = opts || {};
  var result = through.obj();
  var events = opts.events || allContainers(opts);
  var streams = {};
  var containers = {};
  var oldDestroy = result.destroy;
  var interval = opts.statsinterval || 1;
  var containerDelay = opts.containerDelay || 0;
  var streamMode = true;
  if (typeof opts.streamMode !== 'undefined' &&
      opts.streamMode !== null) {
    streamMode = opts.streamMode;
  }
  var statsPullInProgress = false;

  function getContainerStats() {
    // if (statsPullInProgress) {return;}
    statsPullInProgress = true;
    async.eachSeries(Object.keys(containers), function(container, next) {
      var containerObj = containers[container];
      if (containerObj && containerObj.docker) {
        containerObj.docker.stats({stream:false}, function(err, stream) {
          if (!err && stream && stream.pipe) {
            stream.pipe(through.obj(function(stats, enc, cb) {
              this.push({
                       v: 0,
                       id: container.slice(0, 12),
                       image: containerObj.meta.image,
                       name: containerObj.meta.name,
                       stats: JSON.parse(stats)
                     });
              cb();
            })).pipe(result, { end: false });
          }
        });
        setTimeout(next, containerDelay);
      }
    }, function() {
      statsPullInProgress = false;
    });
  }

  result.setMaxListeners(0);

  result.destroy = function() {
    Object.keys(streams).forEach(detachContainer);
    events.destroy();
    oldDestroy.call(this);
  };

  events.on('start', attachContainer);
  events.on('stop', function(meta) {
    detachContainer(meta.id);
  });

  if (!streamMode) {
    setInterval(getContainerStats, interval*1000);
  }

  return result;

  function detachContainer(id) {
    if (streams[id]) {
      streams[id].destroy();
      delete streams[id];
    }
    if (containers[id]) {
      delete containers[id];
    }
  }

  function attachContainer(data, container) {
    // we are trying to tap into this container
    // we should not do that, or we might be stuck in
    // an output loop
    if (data.id.indexOf(process.env.HOSTNAME) === 0) {
      return;
    }

    if (streamMode) {
      var stream = nes(container.stats.bind(container));

      streams[data.Id] = stream;

      var previousSystem = 0;
      var previousCpu = 0;

      var sampleCount = 0;
      var cpuSum = 0;
      var sysSum = 0;

      pump(
        stream,
        split(JSON.parse),
        through.obj(function(stats, enc, cb) {
          sampleCount++

          cpuSum += stats.cpu_stats.cpu_usage.total_usage
          sysSum += stats.cpu_stats.system_cpu_usage

          if (sampleCount >= interval) {
            stats.cpu_stats.cpu_usage.total_usage = cpuSum/sampleCount;
            stats.cpu_stats.system_cpu_usage = sysSum/sampleCount;

            var percent = calculateCPUPercent(stats, previousCpu, previousSystem)
            stats.cpu_stats.cpu_usage.cpu_percent = percent

            this.push({
              v: 0,
              id: data.id.slice(0, 12),
              image: data.image,
              name: data.name,
              stats: stats
            })

            previousCpu = stats.cpu_stats.cpu_usage.total_usage
            previousSystem = stats.cpu_stats.system_cpu_usage

            sampleCount = 0
            cpuSum = 0
            sysSum = 0
          }

          cb()
        })
      ).pipe(result, { end: false });
    } else {
      containers[data.id] = {meta: data, docker: container};
    }
  }

  // Code taken from https://github.com/icecrime/docker-mon/blob/ee9ac3fbaffcdec60d26eedd16204ca0370041d8/widgets/cpu.js
  function calculateCPUPercent(statItem, previousCpu, previousSystem) {
    var cpuDelta = statItem.cpu_stats.cpu_usage.total_usage - previousCpu
    var systemDelta = statItem.cpu_stats.system_cpu_usage - previousSystem
    var cpuPercent = 0.0
    if (systemDelta > 0.0 && cpuDelta > 0.0) {
      cpuPercent = (cpuDelta * 1.0 / systemDelta) * statItem.cpu_stats.cpu_usage.percpu_usage.length * 100.0
    }
    return cpuPercent
  }

}

module.exports = stats

function cli() {
  var argv = require('minimist')(process.argv.slice(2))
  stats({
    statsinterval: argv.statsinterval,
    matchByName: argv.matchByName,
    matchByImage: argv.matchByImage,
    skipByName: argv.skipByName,
    skipByImage: argv.skipByImage,
    streamMode: argv.streamMode,
    containerDelay: argv.containerDelay
  }).pipe(through.obj(function(chunk, enc, cb) {
    this.push(JSON.stringify(chunk))
    this.push('\n')
    cb()
  })).pipe(process.stdout)
}

if (require.main === module) {
  cli()
}
