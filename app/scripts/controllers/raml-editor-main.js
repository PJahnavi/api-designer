(function () {
  'use strict';

  angular.module('ramlEditorApp')
    .constant('UPDATE_RESPONSIVENESS_INTERVAL', 800)
    .controller('ramlEditorMain', function (UPDATE_RESPONSIVENESS_INTERVAL, $scope, $rootScope, $timeout, $window,
      safeApply, safeApplyWrapper, debounce, ramlParserAdapter, ramlExpander, ramlRepository, codeMirror,
      codeMirrorErrors, config, $prompt, $confirm, $modal, mockingServiceClient, $q, ramlEditorMainHelpers
    ) {
      var editor, lineOfCurrentError, currentFile;

      function extractCurrentFileLabel(file) {
        var label = '';
        if (file) {
          label = file.path;
          if (file.dirty) {
            label = '* ' + label;
          }
        }

        return label;
      }

      function calculatePositionOfErrorMark(currentLine) {
        function onlyFolds(textMark) {
          return textMark.__isFold;
        }

        function toStartingLine(textMark) {
          return textMark.find().from.line;
        }

        function toMinimum(currentMin, val) {
          return Math.min(currentMin, val);
        }

        var position = { line: currentLine };
        return editor.findMarksAt(position).filter(onlyFolds).map(toStartingLine).reduce(toMinimum, lineOfCurrentError);
      }

      function formatErrorMessage(message, actualLine, displayLine) {
        if (displayLine === actualLine) {
          return message;
        }

        return 'Error on line ' + (actualLine + 1) + ': ' + message;
      }

      $window.setTheme = function setTheme(theme) {
        config.set('theme', theme);
        $scope.theme = $rootScope.theme = theme;
        safeApply($scope);
      };

      $scope.$on('event:raml-editor-file-selected', function onFileSelected(event, file) {
        currentFile = file;

        if (ramlEditorMainHelpers.isApiDefinitionLike(file.contents)) {
          // Empty console so that we remove content from previous open RAML file
          $rootScope.$broadcast('event:raml-parsed', {});
        }

        // Every file must have a unique document for history and cursors.
        if (!file.doc) {
          file.doc = new CodeMirror.Doc(file.contents);
        }

        editor.swapDoc(file.doc);
        editor.focus();

        // After swapping the doc, configure the editor for the current file
        // extension.
        codeMirror.configureEditor(editor, file.extension);

        $scope.fileParsable = $scope.getIsFileParsable(file);

        // Inform the editor source has changed. This is also called when the
        // editor triggers the change event, swapping the doc does not trigger
        // that event, so we must explicitly call the sourceUpdated function.
        $scope.sourceUpdated();
      });

      $scope.$watch('fileBrowser.selectedFile.contents', function (contents) {
        if (contents != null && contents !== editor.getValue()) {
          currentFile.doc = new CodeMirror.Doc(contents);
          editor.swapDoc(currentFile.doc);
        }
      });

      var updateFile = debounce(function updateFile () {
        $rootScope.$broadcast('event:file-updated');
      }, config.get('updateResponsivenessInterval', UPDATE_RESPONSIVENESS_INTERVAL));

      $scope.$on('event:raml-editor-file-created', updateFile);

      $scope.$on('event:raml-editor-file-removed', updateFile);

      $scope.$on('event:raml-editor-file-removed', function onFileSelected(event, file) {
        if (currentFile === file) {
          currentFile = undefined;
          editor.swapDoc(new CodeMirror.Doc(''));
        }
      });

      $scope.canExportFiles = function canExportFiles() {
        return ramlRepository.canExport();
      };

      $scope.supportsFolders = ramlRepository.supportsFolders;

      $scope.sourceUpdated = function sourceUpdated() {
        var source       = editor.getValue();
        var selectedFile = $scope.fileBrowser.selectedFile;

        $scope.clearErrorMarks();
        selectedFile.contents = source;
        $scope.fileParsable   = $scope.getIsFileParsable(selectedFile);

        updateFile();
      };

      $scope.loadRaml = function loadRaml(definition, location) {
        return ramlParserAdapter.loadPath(location, function contentAsync(path) {
          var file = ramlRepository.getByPath(path);

          if (file) {
            return (file.loaded ? $q.when(file) : ramlRepository.loadFile({path: path}))
              .then(function (file) {
                return file.contents;
              })
            ;
          }

          return $q.reject('ramlEditorMain: loadRaml: contentAsync: ' + path + ': no such path');
        })
          .then(function (raml) {
            return ramlEditorMainHelpers.isApiDefinitionLike(definition) ? raml : null;
          })
        ;
      };

      $scope.clearErrorMarks = function clearErrorMarks() {
        codeMirrorErrors.clearAnnotations();
        $scope.hasErrors = false;
      };

      $scope.$on('event:file-updated', function onFileUpdated() {
        $scope.clearErrorMarks();

        var file = $scope.fileBrowser.selectedFile;

        if (!file || !$scope.fileParsable || file.contents.trim() === '') {
          $scope.currentError = undefined;
          lineOfCurrentError = undefined;
          return;
        }

        $scope.loadRaml(file.contents, file.path).then(
          // success
          safeApplyWrapper($scope, function success(api) {
            var raml = ramlParserAdapter.expandApiToJSON(api);
            ramlExpander.expandRaml(raml);

            $scope.fileBrowser.selectedFile.raml = raml;
            $rootScope.$broadcast('event:raml-parsed', raml);

            // a success, but with warnings (takes to long... skip for now until improvements on parser)
            var errors = api.errors();
            if (errors.length > 0) {
              $rootScope.$broadcast('event:raml-parser-error', {parserErrors: errors});
            }
          }),

          // failure
          safeApplyWrapper($scope, function failure(error) {
            $rootScope.$broadcast('event:raml-parser-error', error);
          })
        );
      });

      $scope.$on('event:raml-parsed', safeApplyWrapper($scope, function onRamlParser(event, raml) {
        $scope.raml         = raml;
        $scope.title        = raml && raml.title;
        $scope.version      = raml && raml.version;
        $scope.currentError = undefined;
        lineOfCurrentError  = undefined;
      }));

      $scope.$on('event:raml-parser-error', safeApplyWrapper($scope, function onRamlParserError(event, error) {
        var parserErrors = error.parserErrors || [{line: 0, column: 1, message: error.message, isWarning: error.isWarning}];

        codeMirrorErrors.displayAnnotations(parserErrors.map(function mapErrorToAnnotation(error) {
          var errorInfo = error;
          var tracingInfo = { line : undefined, column : undefined, path : undefined };
          var needErrorPath = error.trace !== undefined;

          function findError(errors, selectedFile) {
            for (var i = 0; i < errors.length; i++) {
              var error = errors[i];
              if (error.path === selectedFile.name) {
                error.from = errorInfo;
                return error;
              }
              else {
                var innerError = findError(error.trace, selectedFile);
                if (innerError) {
                  innerError.from = error;
                  return innerError;
                }
              }
            }
          }

          if (needErrorPath) {
            var selectedFile = event.currentScope.fileBrowser.selectedFile;
            errorInfo = findError(error.trace, selectedFile);
            errorInfo.isWarning = error.isWarning;

            var selectedFilePath = selectedFile.path;
            var directorySeparator = '/';
            var lastDirectoryIndex = selectedFilePath.lastIndexOf(directorySeparator) + 1;
            var folderPath = selectedFilePath.substring(selectedFilePath[0] === directorySeparator ? 1 : 0, lastDirectoryIndex);
            var range = errorInfo.from.range;

            tracingInfo = {
              line : ((range && range.start.line) || 0) + 1,
              column : (range && range.start.column) || 1,
              path : folderPath + errorInfo.from.path
            };
          }

          return {
            line          : ((errorInfo.range && errorInfo.range.start.line) || 0) + 1,
            column        : (errorInfo.range && errorInfo.range.start.column) || 1,
            message       : errorInfo.message,
            severity      : errorInfo.isWarning ? 'warning' : 'error',
            path          : tracingInfo.path,
            tracingLine   : tracingInfo.line,
            tracingColumn : tracingInfo.column
          };
        }));
      }));

      $scope.openHelp = function openHelp() {
        $modal.open({
          templateUrl: 'views/help.html'
        });
      };

      $scope.getIsFileParsable = function getIsFileParsable(file) {
        return ramlEditorMainHelpers.isRamlFile(file.extension) &&
          ramlEditorMainHelpers.isApiDefinitionLike(file.contents);
      };

      $scope.getIsMockingServiceVisible = function getIsMockingServiceVisible() {
        if ($scope.mockingServiceDisabled || !$scope.fileParsable) {
          return false;
        }

        return true;
      };

      $scope.getIsShelfVisible = function getIsShelfVisible() {
        if (!$scope.fileParsable) {
          return false;
        }

        return true;
      };

      $scope.getIsConsoleVisible = function getIsConsoleVisible() {
        return $scope.fileParsable && $scope.raml;
      };

      $scope.toggleShelf = function toggleShelf() {
        $scope.shelf.collapsed = !$scope.shelf.collapsed;
        config.set('shelf.collapsed', $scope.shelf.collapsed);
      };

      $scope.getSelectedFileAbsolutePath = function getSelectedFileAbsolutePath() {
        return extractCurrentFileLabel(currentFile);
      };

      $scope.$on('event:toggle-theme', function onToggleTheme() {
        $window.setTheme(($scope.theme === 'dark') ? 'light' : 'dark');
      });

      (function bootstrap() {
        $scope.currentError    = undefined;
        $scope.theme           = $rootScope.theme = config.get('theme', 'dark');
        $scope.shelf           = {};
        $scope.shelf.collapsed = JSON.parse(config.get('shelf.collapsed', 'false'));
        $scope.editor          = editor = codeMirror.initEditor();

        editor.on('fold', function (cm, start, end) {
          if (start.line <= lineOfCurrentError && lineOfCurrentError <= end.line) {
            codeMirrorErrors.displayAnnotations([{
              line:    start.line + 1,
              message: formatErrorMessage($scope.currentError.message, lineOfCurrentError, start.line)
            }]);
          }
        });

        editor.on('unfold', function () {
          var displayLine = calculatePositionOfErrorMark(lineOfCurrentError);

          var message = formatErrorMessage($scope.currentError.message, lineOfCurrentError, displayLine);
          codeMirrorErrors.displayAnnotations([{
            line:    displayLine + 1,
            message: message
          }]);
        });

        editor.on('change', function onChange() {
          $scope.sourceUpdated();
        });

        $window.alreadyNotifiedExit = false;

        $window.editorFilesystemIsDirty = function editorFilesystemIsDirty() {
          var dirtyFile = false;
          $scope.homeDirectory.forEachChildDo(function (t) {
            dirtyFile = t.dirty || dirtyFile;
          });

          return dirtyFile;
        };

        // Warn before leaving the page
        $window.onbeforeunload = function () {
          if (!$window.alreadyNotifiedExit && $window.editorFilesystemIsDirty()) {
            return 'WARNING: You have unsaved changes. Those will be lost if you leave this page.';
          }
        };

        if ($scope.mockingServiceBaseUri) {
          mockingServiceClient.baseUri = $scope.mockingServiceBaseUri;
        }
      })();
    })
  ;
})();
