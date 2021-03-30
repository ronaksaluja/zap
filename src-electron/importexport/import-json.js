/**
 *
 *    Copyright (c) 2020 Silicon Labs
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */
const fs = require('fs')
const util = require('../util/util.js')
const dbEnum = require('../../src-shared/db-enum.js')
const env = require('../util/env.js')
const queryConfig = require('../db/query-config.js')
const queryPackage = require('../db/query-package.js')
const queryImpexp = require('../db/query-impexp.js')
const querySession = require('../db/query-session.js')

/**
 * Resolves with a promise that imports session key values.
 *
 * @param {*} db
 * @param {*} sessionId
 * @param {*} keyValuePairs
 */
async function importSessionKeyValues(db, sessionId, keyValuePairs) {
  let allQueries = []
  if (keyValuePairs != null) {
    env.logInfo(`Loading ${keyValuePairs.length} key value pairs.`)
    // Write key value pairs
    keyValuePairs.forEach((element) => {
      allQueries.push(
        querySession.updateSessionKeyValue(
          db,
          sessionId,
          element.key,
          element.value
        )
      )
    })
  }
  return Promise.all(allQueries).then(() => sessionId)
}

// Resolves into a { packageId:, packageType:}
// object, pkg has`path`, `version`, `type`. It can ALSO have pathRelativity. If pathRelativity is missing
// path is considered absolute.
async function importSinglePackage(db, sessionId, pkg, zapFilePath) {
  let absPath = pkg.path
  if ('pathRelativity' in pkg) {
    absPath = util.createAbsolutePath(pkg.path, pkg.pathRelativity, zapFilePath)
  }
  let pkgId = await queryPackage.getPackageIdByPathAndTypeAndVersion(
    db,
    absPath,
    pkg.type,
    pkg.version
  )

  if (pkgId != null) {
    // Perfect match found, return it and be done.
    return {
      packageId: pkgId,
      packageType: pkg.type,
    }
  }

  // Now we have to perform the guessing logic.
  env.logInfo(
    'Packages from the file did not match loaded packages making best bet.'
  )
  let packages = await queryPackage.getPackagesByType(db, pkg.type)

  // If there isn't any, then abort, but if there is only one, use it.
  if (packages.length == 0) {
    if (pkg.type == dbEnum.packageType.genTemplatesJson) {
      // We don't throw exception for genTemplatesJson, we can survive without.
      env.logInfo(`No packages of type ${pkg.type} found in the database.`)
      return null
    } else {
      throw `No packages of type ${pkg.type} found in the database.`
    }
  } else if (packages.length == 1) {
    env.logInfo(`Only one package of given type ${pkg.type} present. Using it.`)
    return {
      packageId: packages[0].id,
      packageType: pkg.type,
    }
  }

  // Filter to just the ones that match the version
  packages = packages.filter((p) => p.version == pkg.version)
  // If there isn't any abort, if there is only one, use it.
  if (packages.length == 0) {
    if (pkg.type == dbEnum.packageType.genTemplatesJson) {
      // We don't throw exception for genTemplatesJson, we can survive without.
      env.logInfo(
        `No packages of type ${pkg.type} that match version ${pkg.version} found in the database.`
      )
      return null
    } else {
      throw `No packages of type ${pkg.type} that match version ${pkg.version} found in the database.`
    }
  } else if (packages.length == 1) {
    env.logInfo(
      `Only one package of given type ${pkg.type} and version ${pkg.version} present. Using it.`
    )
    return {
      packageId: packages[0].id,
      packageType: pkg.type,
    }
  }

  // We now know we have more than 1 matching package. Find best bet.
  let existingPackages = packages.filter((p) => fs.existsSync(p.path))

  if (existingPackages.length == 1) {
    // Only one exists, use that one.
    let p = existingPackages[0]
    env.logWarning(`Using only package that exists:${p.id}.`)
    return {
      packageId: p.id,
      packageType: pkg.type,
    }
  } else if (existingPackages.length > 1) {
    // More than one exists. Use the first one.
    let p = existingPackages[0]
    env.logWarning(
      `Using first package that exists out of ${existingPackages.length}: ${p.id}.`
    )
    return {
      packageId: p.id,
      packageType: pkg.type,
    }
  } else {
    // None exists, so use the first one from 'packages'.
    let p = packages[0]
    env.logWarning(
      `None of packages exist, so using first one overall: ${p.id}.`
    )
    return {
      packageId: p.id,
      packageType: pkg.type,
    }
  }
}

// Resolves an array of { packageId:, packageType:} objects into { packageId: id, otherIds: [] }
function convertPackageResult(sessionId, data) {
  let ret = {
    sessionId: sessionId,
    packageId: null,
    otherIds: [],
    optionalIds: [],
  }
  data.forEach((obj) => {
    if (obj == null) return null
    if (obj.packageType == dbEnum.packageType.zclProperties) {
      ret.packageId = obj.packageId
    } else if (obj.packageType == dbEnum.packageType.genTemplatesJson) {
      ret.otherIds.push(obj.packageId)
    } else {
      ret.optionalIds.push(obj.packageId)
    }
  })
  return ret
}

// Returns a promise that resolves into an object containing: packageId and otherIds
async function importPackages(db, sessionId, packages, zapFilePath) {
  let allQueries = []
  if (packages != null) {
    env.logInfo(`Loading ${packages.length} packages`)
    packages.forEach((p) => {
      allQueries.push(importSinglePackage(db, sessionId, p, zapFilePath))
    })
  }
  return Promise.all(allQueries).then((data) =>
    convertPackageResult(sessionId, data)
  )
}

async function importEndpointTypes(
  db,
  sessionId,
  packageId,
  endpointTypes,
  endpoints
) {
  let allQueries = []
  let sortedEndpoints = {}
  if (endpoints != null) {
    endpoints.forEach((ep) => {
      let eptIndex = ep.endpointTypeIndex
      if (sortedEndpoints[eptIndex] == null) sortedEndpoints[eptIndex] = []
      sortedEndpoints[eptIndex].push(ep)
    })
  }

  if (endpointTypes != null) {
    env.logInfo(`Loading ${endpointTypes.length} endpoint types`)
    endpointTypes.forEach((et, index) => {
      allQueries.push(
        queryImpexp
          .importEndpointType(db, sessionId, packageId, et)
          .then((endpointId) => {
            // Now we need to import commands, attributes and clusters.
            let promises = []
            if (sortedEndpoints[index]) {
              sortedEndpoints[index].forEach((endpoint) => {
                promises.push(
                  queryImpexp.importEndpoint(
                    db,
                    sessionId,
                    endpoint,
                    endpointId
                  )
                )
              })
            }
            // et.clusters
            et.clusters.forEach((cluster) => {
              // code, mfgCode, side
              promises.push(
                queryImpexp
                  .importClusterForEndpointType(
                    db,
                    packageId,
                    endpointId,
                    cluster
                  )
                  .then((endpointClusterId) => {
                    let ps = []

                    if ('commands' in cluster)
                      cluster.commands.forEach((command) => {
                        ps.push(
                          queryImpexp.importCommandForEndpointType(
                            db,
                            packageId,
                            endpointId,
                            endpointClusterId,
                            command
                          )
                        )
                      })

                    if ('attributes' in cluster)
                      cluster.attributes.forEach((attribute) => {
                        ps.push(
                          queryImpexp.importAttributeForEndpointType(
                            db,
                            packageId,
                            endpointId,
                            endpointClusterId,
                            attribute
                          )
                        )
                      })
                    return Promise.all(ps)
                  })
              )
            })
            return Promise.all(promises)
          })
      )
    })
  }
  return Promise.all(allQueries)
}

/**
 * Given a state object, this method returns a promise that resolves
 * with the succesfull writing into the database.
 *
 * @export
 * @param {*} db
 * @param {*} state
 * @param {*} sessionId If null, then new session will get
 *              created, otherwise it loads the data into an
 *              existing session. Previous session data is not deleted.
 * @returns a promise that resolves into a sessionId that was created.
 */
async function jsonDataLoader(db, state, sessionId) {
  return importPackages(db, sessionId, state.package, state.filePath).then(
    (data) => {
      // data: { sessionId, packageId, otherIds, optionalIds}
      let promisesStage0 = []
      let promisesStage1 = [] // Stage 1 is endpoint types
      let promisesStage2 = [] // Stage 2 is endpoints, which require endpoint types to be loaded prior.
      if (data.optionalIds.length > 0) {
        data.optionalIds.forEach((optionalId) =>
          promisesStage0.push(
            queryPackage.insertSessionPackage(db, sessionId, optionalId)
          )
        )
      }

      if ('keyValuePairs' in state) {
        promisesStage1.push(
          importSessionKeyValues(db, data.sessionId, state.keyValuePairs)
        )
      }

      if ('endpointTypes' in state) {
        promisesStage1.push(
          importEndpointTypes(
            db,
            data.sessionId,
            data.packageId,
            state.endpointTypes,
            state.endpoints
          )
        )
      }

      return Promise.all(promisesStage0)
        .then(() => Promise.all(promisesStage1))
        .then(() => Promise.all(promisesStage2))
        .then(() => querySession.setSessionClean(db, data.sessionId))
        .then(() => {
          return {
            sessionId: data.sessionId,
            errors: [],
            warnings: [],
          }
        })
    }
  )
}

/**
 * Parses JSON file and creates a state object out of it, which is passed further down the chain.
 *
 * @param {*} filePath
 * @param {*} data
 * @returns Promise of parsed JSON object
 */
async function readJsonData(filePath, data) {
  let state = JSON.parse(data)
  if (!('featureLevel' in state)) {
    state.featureLevel = 0
  }
  let status = util.matchFeatureLevel(state.featureLevel)

  if (status.match) {
    if (!('keyValuePairs' in state)) {
      state.keyValuePairs = []
    }
    state.filePath = filePath
    state.keyValuePairs.push({
      key: dbEnum.sessionKey.filePath,
      value: filePath,
    })
    state.loader = jsonDataLoader
    return state
  } else {
    throw status.message
  }
}

exports.readJsonData = readJsonData
