module.exports = function (grunt) {
    grunt.initConfig({
        pkg: grunt.file.readJSON('package.json'),
        uncss: {
            dist: {
                files: {
                    'dist/css/allcss.css': ['index.html']
                }
            }
        },
        cssmin: {
            options: {
                shorthandCompacting: false,
                roundingPrecision: -1
            },
            target: {
                files: {
                    'dist/css/min.css': ['dist/css/allcss.css']
                }
            }
        },
        uglify: {
            js: {
                files: {
                    'dist/js/all.min.js': [
                        'js/jquery.js',
                        'js/bootstrap.min.js',
                        'js/jquery.easing.min.js',
                        'js/classie.js',
                        'js/cbpAnimatedHeader.js',
                        'js/freelancer.js'
                    ]
                }
            },
            options: {
                banner: '\n/*! <%= pkg.name %> <%= grunt.template.today("dd-mm-yyyy") %> */\n',
                preserveComments: 'some',
                report: 'min'
            }
        },
    });
    grunt.loadNpmTasks('grunt-uncss');
    grunt.loadNpmTasks('grunt-contrib-cssmin');

    // Load the plugin that provides the "uglify" task.
    grunt.loadNpmTasks('grunt-contrib-uglify');

    // Default task(s).
    grunt.registerTask('default', ['uglify']);
};