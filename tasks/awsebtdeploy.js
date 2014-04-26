/*
 * grunt-awsebtdeploy
 * https://github.com/simoneb/grunt-awsebtdeploy
 *
 * Copyright (c) 2014 Simone Busoli
 * Licensed under the MIT license.
 */

'use strict';

module.exports = function (grunt) {
  var AWS = require('aws-sdk'),
      path = require('path'),
      fs = require('fs'),
      get = require('http').get,
      util = require('util'),
      Q = require('q'),
      qAWS;

  function findEnvironmentByCNAME(data, cname) {
    if (!data || !data.Environments) return false;

    return data.Environments.filter(function (e) {
      return e.CNAME === cname;
    })[0];
  }

  function createEnvironmentName(applicationName) {
    var maxLength = 23,
        time = new Date().getTime().toString(),
        timeLength = time.length,
        availableSpace = maxLength - applicationName.length,
        timePart = time.substring(timeLength - availableSpace, timeLength);

    if (applicationName.length > maxLength - 3)
      grunt.log.subhead('Warning: application name is too long to guarantee ' +
          'a unique environment name, maximum length ' +
          maxLength + ' characters');

    return applicationName + timePart;
  }

  function wrapAWS(eb, s3) {
    return {
      describeApplications: Q.nbind(eb.describeApplications, eb),
      describeEnvironments: Q.nbind(eb.describeEnvironments, eb),
      putS3Object: Q.nbind(s3.putObject, s3),
      createApplicationVersion: Q.nbind(eb.createApplicationVersion, eb),
      updateEnvironment: Q.nbind(eb.updateEnvironment, eb),
      createConfigurationTemplate: Q.nbind(eb.createConfigurationTemplate, eb),
      swapEnvironmentCNAMEs: Q.nbind(eb.swapEnvironmentCNAMEs, eb),
      createEnvironment: Q.nbind(eb.createEnvironment, eb)
    };
  }

  grunt.registerMultiTask('awsebtdeploy', 'A grunt plugin to deploy applications to AWS Elastic Beanstalk', function () {
    if (!this.data.options.applicationName) grunt.warn('Missing "applicationName"');
    if (!this.data.options.environmentCNAME) grunt.warn('Missing "environmentCNAME"');
    if (!this.data.options.region) grunt.warn('Missing "region"');
    if (!this.data.options.sourceBundle) grunt.warn('Missing "sourceBundle"');

    if (!grunt.file.isFile(this.data.options.sourceBundle))
      grunt.warn('"sourceBundle" points to a non-existent file');

    if (!this.data.options.healthPage) {
      grunt.log.subhead('Warning: "healthPage" is not set, it is recommended to set one');
    } else if (this.data.options.healthPage[0] !== '/') {
      this.data.options.healthPage = '/' + this.data.options.healthPage;
    }

    var task = this,
        done = this.async(),
        options = this.options({
          versionLabel: path.basename(this.data.options.sourceBundle,
              path.extname(this.data.options.sourceBundle)),
          versionDescription: '',
          deployType: 'inPlace',
          s3: {
            bucket: this.data.options.applicationName,
            key: path.basename(this.data.options.sourceBundle)
          }
        });

    // overwriting properties which might have been passed but undefined
    if (!options.accessKeyId) options.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    if (!options.secretAccessKey) options.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!options.accessKeyId) grunt.warn('Missing "accessKeyId"');
    if (!options.secretAccessKey) grunt.warn('Missing "secretAccessKey"');

    AWS.config.update({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region
    });

    qAWS = wrapAWS(new AWS.ElasticBeanstalk(), new AWS.S3());

    grunt.log.subhead('Operating in region "' + options.region + '"');

    function createConfigurationTemplate(env) {
      grunt.log.write('Creating configuration template of current environment for swap deploy...');

      var templateName = options.applicationName + '-' + new Date().getTime();

      return qAWS.createConfigurationTemplate({
        ApplicationName: options.applicationName,
        EnvironmentId: env.EnvironmentId,
        TemplateName: templateName
      }).then(function (data) {
            grunt.log.ok();
            return [env, data];
          });
    }

    function createNewEnvironment(env, templateData) {
      var newEnvName = createEnvironmentName(options.applicationName);

      grunt.log.write('Creating new environment "' + newEnvName + '"...');

      return qAWS.createEnvironment({
        ApplicationName: options.applicationName,
        EnvironmentName: newEnvName,
        VersionLabel: options.versionLabel,
        TemplateName: templateData.TemplateName
      }).then(function (data) {
            grunt.log.ok();
            return [env, data];
          });
    }

    function swapEnvironmentCNAMEs(oldEnv, newEnv) {
      grunt.log.write('Swapping environment CNAMEs...');

      return qAWS.swapEnvironmentCNAMEs({
        SourceEnvironmentName: oldEnv.EnvironmentName,
        DestinationEnvironmentName: newEnv.EnvironmentName
      }).then(function () {
            grunt.log.ok();
            return oldEnv;
          });
    }

    function swapDeploy(env) {
      return createConfigurationTemplate(env)
          .spread(createNewEnvironment)
          .spread(function (oldEnv, newEnv) {
            return waitForDeployment(newEnv, 20000, 10 * 60 * 1000)
                .then(waitForHealthPage)
                .then(swapEnvironmentCNAMEs.bind(task, oldEnv, newEnv))
                .then(waitForHealthPage);
          });
    }

    function updateEnvironment(env) {
      return qAWS.updateEnvironment({
        EnvironmentName: env.EnvironmentName,
        VersionLabel: options.versionLabel,
        Description: options.versionDescription
      }).then(function () {
            grunt.log.ok();
            return env;
          });
    }

    function inPlaceDeploy(env) {
      grunt.log.write('Updating environment for in-place deploy...');

      return updateEnvironment(env)
          .then(waitForDeployment)
          .then(waitForHealthPage);
    }

    function waitForDeployment(env, delay, timeout) {
      delay = delay || 5000;
      timeout = timeout || 2 * 60 * 1000;

      grunt.log.writeln('Waiting for environment to become ready (timing out in ' +
          (timeout / 60000).toFixed() + ' minutes)...');

      function checkDeploymentComplete() {
        return Q.delay(delay)
            .then(function () {
              return qAWS.describeEnvironments({
                ApplicationName: options.applicationName,
                EnvironmentNames: [env.EnvironmentName],
                VersionLabel: options.versionLabel,
                IncludeDeleted: false
              });
            })
            .then(function (data) {
              if (!data.Environments.length) {
                grunt.log.writeln(options.versionLabel + ' still not deployed to ' +
                    env.EnvironmentName + ' ...');
                return checkDeploymentComplete();
              }

              var currentEnv = data.Environments[0];

              if (currentEnv.Status !== 'Ready') {
                grunt.log.writeln('Environment ' + currentEnv.EnvironmentName +
                    ' status: ' + currentEnv.Status + '...');
                return checkDeploymentComplete();
              }

              if (currentEnv.Health !== 'Green') {
                grunt.log.writeln('Environment ' + currentEnv.EnvironmentName +
                    ' health: ' + currentEnv.Health + '...');
                return checkDeploymentComplete();
              }

              grunt.log.writeln(options.versionLabel + ' has been deployed to ' +
                  currentEnv.EnvironmentName + ' and environment is Ready and Green');

              return currentEnv;
            });
      }

      return Q.timeout(checkDeploymentComplete(), timeout);
    }

    function waitForHealthPage(env, delay, timeout) {
      delay = delay || 5000;
      timeout = timeout || 5 * 60 * 1000;

      if (!options.healthPage) {
        return;
      }

      function checkHealthPageStatus() {
        grunt.log.write('Checking health page status...');

        var deferred = Q.defer();

        get({
              hostname: env.CNAME,
              path: options.healthPage,
              headers: {
                'cache-control': 'no-cache'
              }
            },
            function (res) {
              if (res.statusCode === 200) {
                grunt.log.ok();
                deferred.resolve(res);
              } else {
                grunt.log.writeln('Status ' + res.statusCode);
                deferred.resolve(Q.delay(delay).then(checkHealthPage));
              }
            });

        return deferred.promise;
      }

      function checkHealthPageContents(res) {
        var body,
            deferred = Q.defer();

        if (!options.healthPageContents) return;

        grunt.log.write('Checking health page contents against ' +
            options.healthPageContents + '...');

        res.setEncoding('utf8');

        res.on('data', function (chunk) {
          if (!body) body = chunk;
          else body += chunk;
        });
        res.on('end', function () {
          var ok;

          if (util.isRegExp(options.healthPageContents)) {
            ok = options.healthPageContents.test(body);
          } else {
            ok = options.healthPageContents === body;
          }

          if (ok) {
            grunt.log.ok();
            deferred.resolve();
          } else {
            grunt.log.error('Got ' + body);
            deferred.resolve(Q.delay(delay).then(checkHealthPage));
          }
        });

        return deferred.promise;
      }

      function checkHealthPage() {
        return checkHealthPageStatus()
            .then(checkHealthPageContents);
      }

      grunt.log.writeln('Checking health page of ' + env.CNAME +
          ' (timing out in ' + (timeout / 60000).toFixed() + ' minutes)...');

      return Q.timeout(checkHealthPage(), timeout);
    }

    function invokeDeployType(env) {
      switch (options.deployType) {
        case 'inPlace':
          return inPlaceDeploy(env);
        case 'swapToNew':
          return swapDeploy(env);
        default:
          grunt.warn('Deploy type "' + options.deployType + '" unrecognized');
      }
    }

    function createApplicationVersion(env) {
      grunt.log.write('Creating application version "' + options.versionLabel + '"...');

      return qAWS.createApplicationVersion({
        ApplicationName: options.applicationName,
        VersionLabel: options.versionLabel,
        SourceBundle: {
          S3Bucket: options.s3.bucket,
          S3Key: options.s3.key
        }
      }).then(function () {
            grunt.log.ok();
            return env;
          });
    }

    function uploadApplication(env) {
      var s3Object = {};

      for (var key in options.s3) {
        if (options.s3.hasOwnProperty(key)) {
          s3Object[key.substring(0, 1).toUpperCase() + key.substring(1)] =
              options.s3[key];
        }
      }

      grunt.verbose.writeflags(s3Object, 's3Param');

      s3Object.Body = new Buffer(fs.readFileSync(options.sourceBundle));

      grunt.log.write('Uploading source bundle "' + options.sourceBundle +
          '" to S3 location "' + options.s3.bucket + '/' + options.s3.key + '"...');

      return qAWS.putS3Object(s3Object)
          .then(function () {
            grunt.log.ok();
            return env;
          });
    }

    function checkEnvironmentExists() {
      grunt.log.write('Checking that environment with CNAME "' + options.environmentCNAME + '" exists...');

      return qAWS.describeEnvironments({
        ApplicationName: options.applicationName,
        IncludeDeleted: false
      }).then(function (data) {
            grunt.verbose.writeflags(data, 'Environments');

            var env = findEnvironmentByCNAME(data, options.environmentCNAME);

            if (!env) {
              grunt.log.error();
              grunt.warn('Environment with CNAME "' + options.environmentCNAME + '" does not exist');
            }

            grunt.log.ok();
            return env;
          });
    }

    function checkApplicationExists() {
      grunt.log.write('Checking that application "' + options.applicationName + '" exists...');

      return qAWS.describeApplications({ ApplicationNames: [options.applicationName] })
          .then(function (data) {
            grunt.verbose.writeflags(data, 'Applications');

            if (!data.Applications.length) {
              grunt.log.error();
              grunt.warn('Application "' + options.applicationName + '" does not exist');
            }

            grunt.log.ok();
          });
    }

    return checkApplicationExists()
        .then(checkEnvironmentExists)
        .then(uploadApplication)
        .then(createApplicationVersion)
        .then(invokeDeployType)
        .then(done, done);
  });
};