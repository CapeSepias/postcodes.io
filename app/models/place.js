"use strict";

const fs = require("fs");
const util = require("util");
const async = require("async");
const OSPoint = require("ospoint");
const Base = require("./index").Base;
const QueryStream = require("pg-query-stream");

const placeSchema = {
	"id": "SERIAL PRIMARY KEY",
	"code": "VARCHAR(255)",
	"longitude" : "DOUBLE PRECISION",
	"latitude" : "DOUBLE PRECISION",
	"location" : "GEOGRAPHY(Point, 4326)",
	"eastings" : "INTEGER",
	"northings" : "INTEGER",
	"min_eastings" : "INTEGER",
	"min_northings" : "INTEGER",
	"max_eastings" : "INTEGER",
	"max_northings" : "INTEGER",
	"bounding_polygon": "GEOGRAPHY(Polygon, 4326)",
	"local_type": "VARCHAR(128)",
	"outcode": "VARCHAR(5)",
	"name_1": "VARCHAR(128)",
	"name_1_lang": "VARCHAR(10)",
	"name_2": "VARCHAR(128)",
	"name_1_lang": "VARCHAR(10)",
	"county_unitary": "VARCHAR(128)",
	"county_unitary_type": "VARCHAR(128)",
	"district_borough": "VARCHAR(128)",
	"district_borough_type": "VARCHAR(128)",
	"region": "VARCHAR(32)",
	"country": "VARCHAR(16)"
};

const indexes = [{
	unique: true,
	column: "code"
}, {
	column: "name_1",
	opClass: "varchar_pattern_ops"
}, {
	column: "name_2",
	opClass: "varchar_pattern_ops"
}, {
	type: "GIST",
	column: "location"
}, {
	type: "GIST",
	column: "bounding_polygon"
}];

function Place () {
	this.idCache = [];
	Base.call(this, "places", placeSchema, indexes);
}

util.inherits(Place, Base);

// Return place by `code`
Place.prototype.findByCode = function (code, callback) {

};

// Search for place by name
Place.prototype.search = function (name, callback) {

};

// Retrieve random place
Place.prototype.random = function (callback) {

};

// Format place object
Place.prototype.toJson = function (place) {
	return {};
};

const csvColumns = {
	code: 0,
	names_uri: 1,
	name_1: 2,
	name_1_lang: 3,
	name_2: 4,
	name_2_lang: 5,
	type: 6,
	local_type: 7,
	eastings: 8,
	northings: 9,
	most_detail_view_res: 10,
	least_detail_view_res: 11,
	min_eastings: 12,
	min_northings: 13,
	max_eastings: 14,
	max_northings: 15,
	outcode: 16,
	postcode_district_uri: 17,
	populated_place: 18,
	populated_place_uri: 19,
	populated_place_type: 20,
	district_borough: 21,
	district_borough_uri: 22,
	district_borough_type: 23,
	county_unitary: 24,
	county_unitary_uri: 25,
	county_unitary_type: 26,
	region: 27,
	region_uri: 28,
	country: 29,
	country_uri: 30,
	related_spatial_object: 31,
	same_as_dbpedia: 32,
	same_as_geonames: 33
};

// Populates places table given OS data directory
Place.prototype._setupTable = function (directory, callback) {
	const self = this;
	async.series([
		self._createRelation.bind(self),
		self.clear.bind(self),
		function seedData (cb) {
			self.seedData(directory, cb);
		},
		self.populateLocation.bind(self),
		self.createIndexes.bind(self),
	], callback);
};

// Pipe OS places data into places table
Place.prototype.seedData = function (directory, callback) {
	if (!fs.statSync(directory).isDirectory()) {
		return callback(
			new Error("Data directory should be supplied for OS places update")
		);
	}
	const typeIndex = csvColumns["type"];
	const columnWhitelist = ["id", "location", "bounding_polygon"];
	const columns = Object.keys(placeSchema)
		.filter(col => columnWhitelist.indexOf(col) === -1);
	const typeRegex = /^.*\//;
	const parseOsgb = val => parseInt(val, 10) || "";
	const transformExceptions = {
		northings: parseOsgb,
		eastings: parseOsgb,
		min_eastings: parseOsgb,
		min_northings: parseOsgb,
		max_eastings: parseOsgb,
		max_northings: parseOsgb,
		county_unitary_type: val => val.replace(typeRegex, ""),
		district_borough_type: val => val.replace(typeRegex, "")
	};

	const transform = row => {
		// Skip if not a "place"
		if (row[typeIndex] !== "populatedPlace") return null;
		const northings = row[csvColumns["northings"]];
		const eastings = row[csvColumns["eastings"]];
		let location;
		if (northings.length * eastings.length === 0) {
			location = {
				longitude: "",
				latitude: ""
			};
		} else {
			location = new OSPoint("" + northings, "" + eastings).toWGS84();
		}
		return columns.map(colName => {
			if (colName === "latitude") return location.latitude;
			if (colName === "longitude") return location.longitude;
			const columnIndex = csvColumns[colName];
			const value = row[columnIndex];
			const exception = transformExceptions[colName]
			return (exception ? exception(value) : value);
		});
	};

	const files = fs.readdirSync(directory)
		.filter(f => f.match(/\.csv$/))
		.map(f => `${directory}${f}`);

	this._csvSeed({
		filepath: files,
		transform: transform,
		columns: columns.join(",")
	}, callback);
};

// Generates location data including centroid and bounding box 
Place.prototype.populateLocation = function (callback) {
	const self = this;
	async.series([
		function createPolygons (callback) {
			self._getClient((error, client, done) => {
				const updateBuffer = [];
				const cleanup = (error, result) => {
					done();
					callback(error, result);
				};
				const drainBuffer = callback => {
					stream.pause();
					async.each(updateBuffer, self._query.bind(self), error => {
						if (error) return cleanup(error);
						updateBuffer.length = 0;
						if (stream.isPaused()) stream.resume();
						if (callback) callback();
					});
				};
				const streamQuery = new QueryStream(`
					SELECT 
						id, min_eastings, min_northings, max_eastings, max_northings 
					FROM 
						${self.relation}
				`);
				const stream = client.query(streamQuery);
				stream.on("data", place => {
					const locations = [];
					if (place.min_eastings * place.min_northings * 
						place.max_eastings * place.max_northings === 0) return;
					const initialLocation = new OSPoint("" + place.min_eastings, "" + place.min_northings).toWGS84();
					locations.push(initialLocation);
					locations.push((new OSPoint("" + place.max_eastings, "" + place.min_northings).toWGS84()));
					locations.push((new OSPoint("" + place.min_eastings, "" + place.max_northings).toWGS84()));
					locations.push((new OSPoint("" + place.max_eastings, "" + place.max_northings).toWGS84()));
					locations.push(initialLocation); // Round off polygon with initial location
					updateBuffer.push(`
						UPDATE 
							${self.relation} 
						SET 
							bounding_polygon=ST_GeogFromText('SRID=4326;
							POLYGON((${
								locations.map(l => `${l.latitude} ${l.longitude}`).join(",")
							}))') 
						WHERE 
							id=${place.id} 
					`);
					if (updateBuffer.length > 1000) drainBuffer();
				})
				.on("error", cleanup)
				.on("end", () => drainBuffer(cleanup));
			});
		},
		function createLocations (callback) {
			const query = `
				UPDATE 
					${self.relation} 
				SET 
					location=ST_GeogFromText(
						'SRID=4326;POINT(' || longitude || ' ' || latitude || ')'
					) 
				WHERE 
					northings!=0 
					AND eastings!=0
			`;
			self._query(query, callback);
		}
	], callback);
};

module.exports = new Place();
